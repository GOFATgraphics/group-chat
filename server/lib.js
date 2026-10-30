// Shared helpers for the agent API (Vercel serverless functions).
// Every request acts as the signed-in chat user via their Supabase access
// token, so the same row-level security rules as the web app apply.

import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
export const BUCKET = 'chat-files'
export const MAX_FILE_BYTES = 25 * 1024 * 1024
const URL_TTL_SECONDS = 60 * 60

export const usernameToEmail = (username) => `${String(username).trim().toLowerCase()}@chat.local`

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function client(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  })
}

// Who is calling? Accepts either
//   - a personal API key ("gck_..."), created in the app or with
//     public.create_api_key(), which never expires until revoked; or
//   - a Supabase access token from POST /api/login.
// Either way the request then runs as that member under the normal
// row-level security rules.
export async function auth(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) {
    throw new HttpError(401, 'Missing "Authorization: Bearer <API key>" header. Create a key in the app (People → API keys).')
  }
  if (token.startsWith(API_KEY_PREFIX)) return markActive(await keySession(token))

  let claims
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  } catch {
    throw new HttpError(401, 'Invalid API key or access token')
  }
  if (!claims.sub) throw new HttpError(401, 'Invalid API key or access token')
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new HttpError(401, 'Access token expired. Call POST /api/refresh.')
  return markActive({ token, userId: claims.sub, sb: client(token) })
}

// ---- online status for API users ------------------------------------------
// The app shows a member online if they have it open or used the API in the
// last couple of minutes; record that, at most every 30 s per member.

const ACTIVE_EVERY_MS = 30_000
const lastTouched = new Map()

export async function markActive(session, { force = false } = {}) {
  const now = Date.now()
  if (force || now - (lastTouched.get(session.userId) ?? 0) > ACTIVE_EVERY_MS) {
    lastTouched.set(session.userId, now)
    const { error } = await session.sb.rpc('touch_last_seen')
    if (error) console.error('touch_last_seen', error.message)
  }
  return session
}

// ---- personal API keys ------------------------------------------------------

export const API_KEY_PREFIX = 'gck_'
const LAST_USED_EVERY_MS = 5 * 60 * 1000

export const hashKey = (key) => createHash('sha256').update(key).digest('hex')

// Service-role client: used only to look up a key's owner and start a
// session for them. All chat reads and writes use that member's session.
export function admin() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  if (!secret) throw new HttpError(500, 'API keys are not enabled on this server: set SUPABASE_SERVICE_ROLE_KEY in Vercel')
  return createClient(SUPABASE_URL, secret, { auth: { persistSession: false, autoRefreshToken: false } })
}

// Sessions per key hash, reused while this function instance stays warm.
const keySessions = new Map()

async function keySession(key) {
  const hash = hashKey(key)
  const cached = keySessions.get(hash)

  // Checked on every request, so revoking a key cuts it off immediately.
  const adm = admin()
  const { data: row, error } = await adm
    .from('api_keys')
    .select('id, user_id, revoked_at')
    .eq('key_hash', hash)
    .maybeSingle()
  if (error) throw new HttpError(500, error.message)
  if (!row || row.revoked_at) {
    keySessions.delete(hash)
    throw new HttpError(401, 'Invalid or revoked API key')
  }
  if (!cached || Date.now() - cached.usedAt > LAST_USED_EVERY_MS) {
    await adm.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', row.id)
    if (cached) cached.usedAt = Date.now()
  }
  if (cached && cached.expiresAt - 60 > Date.now() / 1000) return cached.session

  // Start a session for the key's owner without their password: generate a
  // one-time sign-in token server-side (nothing is emailed) and redeem it.
  const { data: user, error: userError } = await adm.auth.admin.getUserById(row.user_id)
  if (userError || !user?.user?.email) throw new HttpError(401, 'API key owner no longer exists')
  const { data: link, error: linkError } = await adm.auth.admin.generateLink({ type: 'magiclink', email: user.user.email })
  if (linkError) throw new HttpError(500, `Could not start a session: ${linkError.message}`)
  const { data: otp, error: otpError } = await client().auth.verifyOtp({
    type: 'email',
    token_hash: link.properties.hashed_token,
  })
  if (otpError || !otp.session) throw new HttpError(500, `Could not start a session: ${otpError?.message ?? 'no session'}`)

  const session = { token: otp.session.access_token, userId: row.user_id, sb: client(otp.session.access_token), viaKey: true }
  keySessions.set(hash, { session, expiresAt: otp.session.expires_at, usedAt: Date.now() })
  return session
}

// Wraps a handler with CORS, method routing and uniform JSON errors.
export function route(methods) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', [...Object.keys(methods), 'OPTIONS'].join(', '))
    if (req.method === 'OPTIONS') return res.status(204).end()
    const handler = methods[req.method]
    if (!handler) return res.status(405).json({ error: `Method ${req.method} not allowed` })
    try {
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new HttpError(500, 'Server is missing Supabase environment variables')
      const result = await handler(req, res)
      if (!res.headersSent) res.status(200).json(result ?? { ok: true })
    } catch (err) {
      const status = err.status || 500
      if (status === 500) console.error(err)
      res.status(status).json({ error: err.message || 'Internal error' })
    }
  }
}

// Supabase/PostgREST errors -> HTTP errors with a sensible status.
export function check({ data, error }, notFoundMessage) {
  if (error) {
    const code = error.code || ''
    const status =
      code === 'PGRST301' || /JWT/i.test(error.message) ? 401
        : code === '42501' ? 403
        : code === 'PGRST116' ? 404
        : code.startsWith('23') || code.startsWith('22') ? 400
        : 500
    throw new HttpError(status, status === 404 && notFoundMessage ? notFoundMessage : error.message)
  }
  return data
}

export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string' && req.body) {
    try {
      return JSON.parse(req.body)
    } catch {
      throw new HttpError(400, 'Body must be JSON')
    }
  }
  return {}
}

// Adds usernames, reactions and short-lived download URLs to message rows.
export async function present(sb, rows) {
  if (!rows.length) return []
  const ids = rows.map((m) => m.id)
  const paths = rows.map((m) => m.attachment_path).filter(Boolean)
  const groupIds = [...new Set(rows.map((m) => m.group_id).filter(Boolean))]
  const [profiles, reactions, signed, groups] = await Promise.all([
    sb.from('profiles').select('id, username').then((r) => check(r)),
    sb.from('reactions').select('message_id, user_id, emoji').in('message_id', ids).then((r) => check(r)),
    paths.length ? sb.storage.from(BUCKET).createSignedUrls(paths, URL_TTL_SECONDS).then((r) => r.data ?? []) : [],
    groupIds.length ? sb.from('chat_groups').select('id, name').in('id', groupIds).then((r) => check(r)) : [],
  ])
  const groupNames = Object.fromEntries(groups.map((g) => [g.id, g.name]))
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.username]))
  const urls = Object.fromEntries(signed.map((s) => [s.path, s.signedUrl]))
  return rows.map((m) => ({
    id: m.id,
    conversation: m.recipient_id ? 'direct' : 'group',
    // null for the main group chat; a named group's id and name otherwise
    group_id: m.group_id ?? null,
    group_name: m.group_id ? groupNames[m.group_id] ?? null : null,
    user_id: m.user_id,
    username: names[m.user_id] ?? null,
    recipient_id: m.recipient_id ?? null,
    recipient_username: m.recipient_id ? names[m.recipient_id] ?? null : null,
    reply_to_id: m.reply_to_id ?? null,
    text: m.content,
    kind: kindOf(m),
    call_duration: m.call_duration ?? null,
    attachment: m.attachment_path
      ? {
          path: m.attachment_path,
          name: m.attachment_name,
          type: m.attachment_type,
          size: m.attachment_size,
          duration: m.attachment_duration ?? null,
          url: urls[m.attachment_path] ?? null,
        }
      : null,
    reactions: reactions
      .filter((r) => r.message_id === m.id)
      .map((r) => ({ emoji: r.emoji, user_id: r.user_id, username: names[r.user_id] ?? null })),
    created_at: m.created_at,
  }))
}

// "text", "voice" (a voice note: transcribe attachment.url yourself), "photo",
// "video" or "file".
export function kindOf(m) {
  if (m.call_duration != null) return 'call'
  const t = m.attachment_type ?? ''
  if (t.startsWith('audio/')) return 'voice'
  if (t.startsWith('image/')) return 'photo'
  if (t.startsWith('video/')) return 'video'
  return m.attachment_path ? 'file' : 'text'
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function userIdFor(sb, username) {
  const rows = check(await sb.from('profiles').select('id').eq('username', String(username).trim().toLowerCase()))
  if (!rows.length) throw new HttpError(404, `No member named "${username}"`)
  return rows[0].id
}

// Record read receipts (the ticks other members see) for messages the agent
// has received: group messages and direct messages sent to it.
export async function markRead(sb, userId, rows) {
  const unread = rows
    .filter((m) => m.user_id !== userId && (!m.recipient_id || m.recipient_id === userId))
    .map((m) => ({ message_id: m.id, user_id: userId }))
  if (!unread.length) return
  const { error } = await sb.from('message_reads').upsert(unread, { onConflict: 'message_id,user_id', ignoreDuplicates: true })
  if (error) console.error('markRead', error.message)
}

// Shows (or hides) the "typing…" bubble for this member in a conversation,
// via the same Realtime broadcast channel the app listens on (src/typing.js).
// to: null for the main group chat, the recipient's user id for a private
// chat, or "g:<group id>" for a named group.
export async function broadcastTyping(token, userId, to, typing = true) {
  const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ topic: 'typing', event: 'typing', payload: { user_id: userId, to: to ?? null, typing } }],
    }),
  })
  if (!res.ok) throw new HttpError(502, `Typing broadcast failed (HTTP ${res.status})`)
}

// A named group by id or (case-insensitive) name, among the groups this
// member can see. Returns its id.
export async function groupIdFor(sb, group) {
  const value = String(group).trim()
  const rows = check(await sb.from('chat_groups').select('id, name'))
  const hit = rows.find((g) => g.id === value) ?? rows.find((g) => g.name.toLowerCase() === value.toLowerCase())
  if (!hit) throw new HttpError(404, `No group "${group}" that you are in`)
  return hit.id
}
