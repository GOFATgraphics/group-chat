import { route, auth, admin, check, HttpError } from '../lib.js'
import { weekBounds, twoTierBalances } from '../usage.js'
import { loadUsageForUser, balancesFor } from './usage.js'

// Lock-screen widget data (see public/lock-screen-widget.js and
// ~/workspace/group-chat-lock-screen-widget-SPEC.md).
//
//   GET /api/widget  -> the caller's OWN unread count, latest message
//                       and credit balance, for the Scriptable widget
//                       on their iPhone lock screen.
//
// A web app cannot install a native iOS WidgetKit widget by itself, so
// this endpoint exists for Scriptable (free iOS app): a script fetches
// it with the user's personal API key and draws the widget. The
// endpoint returns ONLY the key owner's data — there is no ?user=
// parameter and no other user's messages or balance ever leave the
// server. Auth is the same auth(req) as the agent API: a gck_ key as
// "Authorization: Bearer <key>" (preferred — the key never lands in a
// URL or a server log), or ?key=<key> as a fallback, mapped onto the
// header before auth runs. No key -> 401.
//
// Unread reuses the app's EXISTING rule (src/Chat.jsx loadInbox),
// computed here with the service-role client: per conversation, seen
// = the newest message the user sent or has a message_reads row for;
// unread = messages from others with id > seen.id. Conversations
// counted are exactly the ones the app shows that user: a restricted
// user (public signup, email NOT ending @chat.local, not owner) gets
// only approved assigned-agent DMs + the Admin DM; a legacy member /
// owner gets their own DMs + the main Group Chat + named groups they
// are a member of. Owner views of other members' DMs are never counted
// (same as the app). profiles.last_seen_at is only an online-status
// timestamp, NOT a read marker — it is not used here.
//
// Balances reuse twoTierBalances() via the usage route's loaders —
// the exact same math as GET /api/usage/balance (20 free credits/week,
// excess draws from additional tokens, fair start 2026-11-09, owner
// exempt). No new data is collected and no migration is needed.

const MESSAGE_COLUMNS =
  'id, user_id, recipient_id, group_id, content, attachment_path, attachment_type, attachment_duration, call_duration, created_at'

const MAX_TEXT_CHARS = 90

const round2 = (v) => Math.round(Number(v ?? 0) * 100) / 100

// The message text as the widget shows it: whitespace collapsed,
// truncated to MAX_TEXT_CHARS with a trailing … when longer. A message
// with no text gets a short label for its attachment kind, or '' when
// there is nothing to show (callers skip those for "latest").
export function widgetText(m) {
  const text = String(m?.content ?? '').replace(/\s+/g, ' ').trim()
  if (text) {
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS - 1).trimEnd() + '…' : text
  }
  if (m?.call_duration != null) return 'Call'
  const type = m?.attachment_type ?? ''
  if (type.startsWith('audio/')) return 'Voice note'
  if (type.startsWith('image/')) return 'Photo'
  if (type.startsWith('video/')) return 'Video'
  return m?.attachment_path ? 'File' : ''
}

// Pure payload builder (exported for tests): takes the key owner's
// rows only — it can never return another user's messages or balance,
// because it is only ever handed this user's rows.
export function buildWidgetPayload({
  userId,
  isRestricted,
  ownerId,
  agentIds = new Set(),
  memberGroupIds = new Set(),
  messages = [],
  readIds = new Set(),
  names = {},
  balances,
  weekReset,
} = {}) {
  const visible = []
  for (const m of messages) {
    if (m.group_id) {
      // Named group: only for non-restricted members of that group.
      if (isRestricted || !memberGroupIds.has(m.group_id)) continue
      visible.push({ ...m, key: `group:${m.group_id}` })
    } else if (m.recipient_id == null) {
      // Main Group Chat: legacy members and the owner only.
      if (isRestricted) continue
      visible.push({ ...m, key: 'group' })
    } else {
      // DM: only the user's own DMs, and for a restricted user only
      // approved assigned agents + the Admin DM.
      const peer = m.user_id === userId ? m.recipient_id : m.user_id
      if (m.user_id !== userId && m.recipient_id !== userId) continue
      if (isRestricted && !agentIds.has(peer) && peer !== ownerId) continue
      visible.push({ ...m, key: `dm:${peer}` })
    }
  }
  const byKey = new Map()
  for (const m of visible) {
    const list = byKey.get(m.key) ?? []
    list.push(m)
    byKey.set(m.key, list)
  }
  let unread = 0
  let latest = null
  for (const rows of byKey.values()) {
    rows.sort((a, b) => b.id - a.id)
    const seen = rows.find((m) => m.user_id === userId || readIds.has(m.id))
    unread += rows.filter((m) => m.user_id !== userId && (!seen || m.id > seen.id)).length
    for (const m of rows) {
      if (m.user_id === userId) continue
      if (!latest || m.id > latest.id) latest = m
    }
  }
  // The newest message from someone else with something to show.
  let latestOut = null
  if (latest) {
    const text = widgetText(latest)
    if (text) {
      const from =
        isRestricted && ownerId != null && latest.user_id === ownerId
          ? 'Admin'
          : (names[latest.user_id] ?? 'Someone')
      latestOut = { from, text, at: latest.created_at ?? null }
    }
  }
  const twoTier = balances ?? twoTierBalances({})
  return {
    unread,
    freeRemaining: round2(twoTier.weekFreeRemaining),
    additionalRemaining: round2(twoTier.additionalRemaining),
    outOfCredits: Boolean(twoTier.outOfCredits),
    weekReset: weekReset ?? weekBounds().resetLabel,
    latest: latestOut,
    updatedAt: new Date().toISOString(),
  }
}

// Load the key owner's widget payload. `adm` is the service-role
// client; every query is scoped by userId explicitly, because RLS is
// bypassed for the service role.
async function loadWidgetPayload(adm, userId) {
  const me = check(
    await adm.from('profiles').select('id, username, is_owner').eq('id', userId).single(),
  )
  // Restricted is decided from the auth user's email, exactly like the
  // app (src/Chat.jsx): a public signup uses a real email, legacy
  // accounts are <username>@chat.local. An unknown email fails closed
  // (restricted).
  let email = ''
  try {
    const { data: authUser } = await adm.auth.admin.getUserById(userId)
    email = authUser?.user?.email ?? ''
  } catch {
    email = ''
  }
  const isRestricted = !me.is_owner && !String(email).endsWith('@chat.local')
  const ownerRow = check(
    await adm.from('profiles').select('id').eq('username', 'mubarak').maybeSingle(),
  )
  const ownerId = ownerRow?.id ?? null
  const requests = check(
    await adm
      .from('agent_requests')
      .select('assigned_agent_id')
      .eq('requested_by', userId)
      .eq('status', 'approved')
      .not('assigned_agent_id', 'is', null),
  )
  const agentIds = new Set(requests.map((r) => r.assigned_agent_id))
  let memberGroupIds = new Set()
  if (!isRestricted) {
    const members = check(
      await adm.from('chat_group_members').select('group_id').eq('user_id', userId),
    )
    memberGroupIds = new Set(members.map((r) => r.group_id))
  }
  // The user's DMs, both directions (bounded, newest first).
  const dmRows = check(
    await adm
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .not('recipient_id', 'is', null)
      .or(`user_id.eq.${userId},recipient_id.eq.${userId}`)
      .order('id', { ascending: false })
      .limit(600),
  )
  // Group messages (main chat + named groups), only for non-restricted
  // users; membership is filtered in buildWidgetPayload.
  let groupRows = []
  if (!isRestricted) {
    groupRows = check(
      await adm
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .is('recipient_id', null)
        .order('id', { ascending: false })
        .limit(300),
    )
  }
  const messages = [...dmRows, ...groupRows]
  const readRows = check(
    await adm
      .from('message_reads')
      .select('message_id')
      .eq('user_id', userId)
      .order('message_id', { ascending: false })
      .limit(800),
  )
  const readIds = new Set(readRows.map((r) => r.message_id))
  // Sender names for the visible messages (bounded).
  const senderIds = [...new Set(messages.map((m) => m.user_id))].slice(0, 100)
  const names = {}
  if (senderIds.length) {
    const profiles = check(await adm.from('profiles').select('id, username').in('id', senderIds))
    for (const p of profiles) names[p.id] = p.username
  }
  const loaded = await loadUsageForUser(adm, userId)
  const twoTier = await balancesFor(adm, userId, loaded, Boolean(me.is_owner))
  return buildWidgetPayload({
    userId,
    isRestricted,
    ownerId,
    agentIds,
    memberGroupIds,
    messages,
    readIds,
    names,
    balances: twoTier,
    weekReset: loaded.week.resetLabel,
  })
}

export const widget = route({
  async GET(req) {
    // ?key= fallback: auth(req) only reads the Authorization header.
    // Prefer the header (the key never lands in a URL or a server log);
    // the query param exists for curl / quick tests.
    if (!req.headers?.authorization && req.query?.key) {
      req.headers = { ...(req.headers ?? {}), authorization: `Bearer ${String(req.query.key).trim()}` }
    }
    const { userId } = await auth(req)
    return loadWidgetPayload(admin(), userId)
  },
})

export default widget
