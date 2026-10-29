// Shared helpers for the agent API (Vercel serverless functions).
// Every request acts as the signed-in chat user via their Supabase access
// token, so the same row-level security rules as the web app apply.

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

// Reads the bearer token and the user id inside it. The signature is checked
// by Supabase on every query, so decoding locally only saves a round trip.
export function auth(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new HttpError(401, 'Missing "Authorization: Bearer <access_token>" header. Get one from POST /api/login.')
  let claims
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  } catch {
    throw new HttpError(401, 'Malformed access token')
  }
  if (!claims.sub) throw new HttpError(401, 'Malformed access token')
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new HttpError(401, 'Access token expired. Call POST /api/refresh.')
  return { token, userId: claims.sub, sb: client(token) }
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
  const [profiles, reactions, signed] = await Promise.all([
    sb.from('profiles').select('id, username').then((r) => check(r)),
    sb.from('reactions').select('message_id, user_id, emoji').in('message_id', ids).then((r) => check(r)),
    paths.length ? sb.storage.from(BUCKET).createSignedUrls(paths, URL_TTL_SECONDS).then((r) => r.data ?? []) : [],
  ])
  const names = Object.fromEntries(profiles.map((p) => [p.id, p.username]))
  const urls = Object.fromEntries(signed.map((s) => [s.path, s.signedUrl]))
  return rows.map((m) => ({
    id: m.id,
    conversation: m.recipient_id ? 'direct' : 'group',
    user_id: m.user_id,
    username: names[m.user_id] ?? null,
    recipient_id: m.recipient_id ?? null,
    recipient_username: m.recipient_id ? names[m.recipient_id] ?? null : null,
    reply_to_id: m.reply_to_id ?? null,
    text: m.content,
    attachment: m.attachment_path
      ? {
          path: m.attachment_path,
          name: m.attachment_name,
          type: m.attachment_type,
          size: m.attachment_size,
          url: urls[m.attachment_path] ?? null,
        }
      : null,
    reactions: reactions
      .filter((r) => r.message_id === m.id)
      .map((r) => ({ emoji: r.emoji, user_id: r.user_id, username: names[r.user_id] ?? null })),
    created_at: m.created_at,
  }))
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
