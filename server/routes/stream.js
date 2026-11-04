// GET /api/messages/stream
//
// Server-Sent Events (SSE) stream of new messages, over plain HTTPS.
//
// Why SSE, and why not direct Supabase Realtime from the listener?
// The listener runs in the Muse VM, where websocket connections fail
// outright (tested 2026-11-04: raw websockets to Supabase Realtime and
// to a public echo server both close with code 1006, while https works).
// So the listener cannot subscribe to Supabase Realtime itself.
//
// Instead, this Vercel function subscribes to Supabase Realtime (Vercel
// is not the VM, and the web app's browser clients already prove
// Realtime works from a normal network), and forwards each new message
// to the listener over HTTPS as an SSE event. The listener never opens
// a websocket, and never polls.
//
// Query parameters, mirroring GET /api/messages:
//   ?after_id=123         only messages newer than this id, sent first
//   ?conversation=group   the main group chat only
//   ?group=<id or name>   only that named group
//   ?with=<username>      only your direct messages with that member
//   ?from_others=1        ignore your own messages
//   ?mark_read=0          don't record read receipts (default: mark as read)
//   ?limit=50             1-200, default 50, for the initial catch-up only
//
// Events (each terminated by a blank line):
//   data: {"messages":[{...presented message...}, ...]}\n\n
//   The first event is the catch-up: every matching message after
//   after_id, in id order. Later events carry one presented message
//   each, as it arrives. A presented message is exactly what
//   GET /api/messages returns (usernames, reactions, attachment URLs),
//   and it is marked read before it is sent, so the
//   seen-as-read-before-replying rule holds exactly as with long-poll.
//
// Heartbeats are SSE comments (": ping"), sent every 15 seconds, with
// no database query behind them.
//
// Lifetime: the stream closes after 50 seconds, well under any
// serverless duration cap, and the client reconnects immediately with
// after_id set to the last id it saw. On reconnect the server first
// sends any messages that arrived during the gap, so nothing is lost
// and nothing is sent twice, as long as the client advances after_id.
//
// Cost, per listener, while idle:
//   - About 72 stream connections per hour (one per 50 seconds).
//   - One initial database query per connection (the catch-up, usually
//     empty), plus one query per real message.
//   - Zero queries while waiting. No repeated empty queries at all.
//   Compare long-poll: 144 connections per hour, each with up to 25
//   empty queries at the 1-second rate, about 3,600 queries per hour.
//
// This handler does NOT use the route() wrapper's JSON path: it writes
// SSE directly to res and returns a promise that resolves only when
// the stream ends, so the wrapper's `if (!res.headersSent)` guard skips
// its JSON response.
import {
  auth, check, present, markRead, userIdFor, groupIdFor, HttpError,
} from '../lib.js'

const STREAM_SECONDS = 50
const HEARTBEAT_MS = 15_000

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// Same scope logic as GET /api/messages, applied to a raw row.
function matchesScope(row, scope) {
  const { userId, conversation, groupId, peerId, fromOthers } = scope
  if (fromOthers && row.user_id === userId) return false
  if (conversation === 'group') return row.recipient_id == null && row.group_id == null
  if (groupId) return row.group_id === groupId
  if (peerId) {
    const pair = [row.user_id, row.recipient_id].sort().join(',')
    return pair === [userId, peerId].sort().join(',')
  }
  if (row.group_id != null) return false
  return row.recipient_id == null || row.recipient_id === userId || row.user_id === userId
}

export default async function handler(req, res) {
  const { sb, token, userId } = await auth(req)
  const q = req.query || {}
  const limit = clamp(Number(q.limit) || 50, 1, 200)
  const fromOthers = q.from_others === '1' || q.from_others === 'true'
  const shouldMarkRead = q.mark_read !== '0' && q.mark_read !== 'false'
  const afterId = Number(q.after_id) || 0

  // Build the same scope as GET /api/messages.
  let scope
  if (q.with) {
    const peer = await userIdFor(sb, q.with)
    scope = { peerId: peer }
    scope.query = (query) =>
      query.or(`and(user_id.eq.${userId},recipient_id.eq.${peer}),and(user_id.eq.${peer},recipient_id.eq.${userId})`)
  } else if (q.group) {
    const groupId = await groupIdFor(sb, q.group)
    scope = { groupId }
    scope.query = (query) => query.eq('group_id', groupId)
  } else if (q.conversation === 'group') {
    scope = { conversation: 'group' }
    scope.query = (query) => query.is('recipient_id', null).is('group_id', null)
  } else {
    scope = {}
    scope.query = (query) => query.or(`recipient_id.is.null,recipient_id.eq.${userId},user_id.eq.${userId}`)
  }
  const filter = { userId, fromOthers, ...scope }
  const base = () => {
    let query = scope.query(sb.from('messages').select('*'))
    if (fromOthers) query = query.neq('user_id', userId)
    return query
  }

  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  let closed = false
  const send = (messages) => {
    if (closed || !messages.length) return
    res.write(`data: ${JSON.stringify({ messages })}\n\n`)
  }

  // The user session token must be given to Realtime explicitly, for
  // the same reason as in the VM listener fix: the global Authorization
  // header is for PostgREST, not for the Realtime websocket.
  try {
    await sb.realtime.setAuth(token)
  } catch (err) {
    console.error('stream setAuth', err.message)
  }

  let channel = null
  const finish = async () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    clearTimeout(timer)
    try { if (channel) await sb.removeChannel(channel) } catch { /* already gone */ }
    try { res.end() } catch { /* already ended */ }
    resolveDone()
  }

  // The promise the wrapper awaits: it resolves only on finish().
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  const heartbeat = setInterval(() => {
    if (closed) return
    try { res.write(': ping\n\n') } catch { finish() }
  }, HEARTBEAT_MS)
  const timer = setTimeout(() => finish(), STREAM_SECONDS * 1000)

  req.on('close', () => finish())
  res.on('close', () => finish())

  // Catch-up first: one query, then subscribe.
  let lastId = afterId
  try {
    const rows = check(await base().gt('id', afterId).order('id').limit(limit))
    if (rows.length) {
      lastId = Math.max(...rows.map((m) => m.id))
      if (shouldMarkRead) await markRead(sb, userId, rows)
      send(await present(sb, rows))
    }
  } catch (err) {
    if (!closed) {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`) } catch { /* gone */ }
    }
    await finish()
    return done
  }

  channel = sb
    .channel(`stream-${userId}-${Date.now()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async ({ new: row }) => {
      if (closed || !row || typeof row.id !== 'number' || row.id <= lastId) return
      lastId = row.id
      if (!matchesScope(row, filter)) return
      try {
        const full = check(await sb.from('messages').select('*').eq('id', row.id).single())
        if (shouldMarkRead) await markRead(sb, userId, [full])
        send(await present(sb, [full]))
      } catch (err) {
        console.error('stream message fetch', err.message)
      }
    })
    .subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('stream channel', status, err ? String(err) : '')
        // Keep the stream open: the client reconnects on close anyway,
        // and the reconnect catch-up covers the gap. Do not end early
        // on a transient channel error; the 50-second timer ends it.
      }
    })

  return done
}
