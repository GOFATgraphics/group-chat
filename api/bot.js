// Adam, the chat's AI member, running entirely on Vercel.
//
// Supabase POSTs every new message Adam may read (group messages and private
// messages to Adam; see the agent_webhooks migration) to this function. It
// acknowledges at once, then asks Claude for a reply and posts it as Adam, so
// a reply lands a few seconds after the message.
//
// GET /api/bot (open it once in a browser after deploying) registers this
// function's production URL as Adam's webhook and reports the setup status.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY   Claude API key
//   BOT_USERNAME        chat username the bot posts as (e.g. adam)
//   BOT_PASSWORD        that user's password
//   BOT_MODEL           optional, default claude-opus-5-5
//   BOT_EFFORT          optional: low | medium | high, default low (fastest)
//   BOT_PERSONA         optional, overrides the text in api/_adam.js

import Anthropic from '@anthropic-ai/sdk'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'node:crypto'
import { client, usernameToEmail, markRead, HttpError, BUCKET } from './_lib.js'
import { PERSONA } from './_adam.js'

const MODEL = process.env.BOT_MODEL || 'claude-opus-5-5'
const EFFORT = process.env.BOT_EFFORT || 'low'
const HISTORY = 40
const NO_REPLY = 'NO_REPLY'

const anthropic = new Anthropic()

// Bot session, reused while this function instance stays warm.
let cached = null

async function botSession() {
  if (cached && cached.expiresAt - 60 > Date.now() / 1000) return cached
  const username = process.env.BOT_USERNAME
  const password = process.env.BOT_PASSWORD
  if (!username || !password) throw new HttpError(500, 'Set BOT_USERNAME and BOT_PASSWORD in Vercel')
  const { data, error } = await client().auth.signInWithPassword({ email: usernameToEmail(username), password })
  if (error) throw new HttpError(500, `Bot login failed for "${username}": ${error.message}`)
  const sb = client(data.session.access_token)
  const { data: hook } = await sb.from('agent_webhooks').select('url, secret').maybeSingle()
  cached = {
    sb,
    userId: data.user.id,
    username: username.trim().toLowerCase(),
    expiresAt: data.session.expires_at,
    hook,
  }
  return cached
}

function secretMatches(header, secret) {
  if (!secret || !header?.startsWith('Bearer ')) return false
  const a = Buffer.from(header.slice(7))
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.status(200).json(await setup())
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    let bot = await botSession()
    if (!secretMatches(req.headers.authorization, bot.hook?.secret)) {
      // The secret may have changed since this instance cached it.
      cached = null
      bot = await botSession()
      if (!secretMatches(req.headers.authorization, bot.hook?.secret)) return res.status(401).json({ error: 'Bad secret' })
    }

    const message = req.body?.message
    if (req.body?.type !== 'message.created' || !message?.id) return res.status(400).json({ error: 'Unexpected payload' })

    // Acknowledge immediately (Supabase waits at most 5 s), then do the work.
    waitUntil(respond(bot, message).catch((err) => console.error('bot reply failed', err)))
    return res.status(202).json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}

// Points Adam's webhook at this deployment's production URL.
async function setup() {
  const status = {
    bot: process.env.BOT_USERNAME || null,
    model: MODEL,
    anthropic_key: Boolean(process.env.ANTHROPIC_API_KEY),
  }
  const bot = await botSession()
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (!host) return { ...status, webhook: bot.hook?.url ?? null, note: 'Not a Vercel production deployment; webhook left unchanged' }
  const url = `https://${host}/api/bot`
  if (bot.hook?.url !== url) {
    const { error } = await bot.sb
      .from('agent_webhooks')
      .upsert({ user_id: bot.userId, url }, { onConflict: 'user_id' })
    if (error) throw new HttpError(500, `Could not register webhook: ${error.message}`)
    cached = null
  }
  return { ...status, webhook: url, ready: status.anthropic_key }
}

async function respond(bot, incoming) {
  const { sb, userId } = bot
  const isDirect = Boolean(incoming.recipient_id)

  // The conversation this message belongs to, as Adam can see it.
  let query = sb.from('messages').select('*').order('id', { ascending: false }).limit(HISTORY)
  query = isDirect
    ? query.or(
        `and(user_id.eq.${userId},recipient_id.eq.${incoming.user_id}),and(user_id.eq.${incoming.user_id},recipient_id.eq.${userId})`,
      )
    : query.is('recipient_id', null)
  const [{ data: rows, error }, { data: profiles }] = await Promise.all([
    query,
    sb.from('profiles').select('id, username'),
  ])
  if (error) throw error
  const history = rows.reverse()
  const names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.username]))
  const nameOf = (id) => (id === userId ? `${names[id] ?? bot.username} (you)` : names[id] ?? 'someone')

  await markRead(sb, userId, history)

  // A newer message in the same conversation will trigger its own reply with
  // fuller context, so skip this one instead of answering twice.
  const newestFromOthers = history.filter((m) => m.user_id !== userId).at(-1)
  if (newestFromOthers && newestFromOthers.id > incoming.id) return

  const transcript = history
    .map((m) => {
      const parts = [`[#${m.id}] ${nameOf(m.user_id)}`]
      if (m.reply_to_id) parts.push(`(replying to #${m.reply_to_id})`)
      let line = `${parts.join(' ')}: ${m.content ?? ''}`
      if (m.attachment_name) line += ` [attached ${m.attachment_type?.startsWith('image/') ? 'photo' : 'file'}: ${m.attachment_name}]`
      return line
    })
    .join('\n')

  const content = []
  if (incoming.attachment_path && incoming.attachment_type?.startsWith('image/')) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrl(incoming.attachment_path, 600)
    if (data?.signedUrl) content.push({ type: 'image', source: { type: 'url', url: data.signedUrl } })
  }
  content.push({
    type: 'text',
    text:
      `${isDirect ? `Private conversation between you and ${nameOf(incoming.user_id)}.` : 'Group chat.'}\n\n` +
      `${transcript}\n\n` +
      `The newest message is #${incoming.id} from ${nameOf(incoming.user_id)}. Write your next message.`,
  })

  const members = Object.values(names).join(', ')
  const system =
    `${process.env.BOT_PERSONA || PERSONA}\n\n` +
    `Your username in the chat is "${bot.username}". The members are: ${members}.\n` +
    `Each request shows the recent conversation, one message per line as "[#id] name: text". ` +
    `Reply with only the text of your next chat message: no "[#id]", no name prefix, no quotes.` +
    (isDirect
      ? ''
      : `\nIn the group chat, not every message needs you. If the newest message is clearly meant for ` +
        `someone else, is a conversation you have nothing to add to, or just wraps up a topic, reply with ` +
        `exactly ${NO_REPLY} and nothing else. Always answer when someone mentions you by name, asks you ` +
        `something, or replies to one of your messages.`)

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: EFFORT },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
  })
  if (response.stop_reason === 'refusal') return

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text || text === NO_REPLY) return

  // Still the latest? If someone wrote again while Claude was thinking, let
  // that message's own invocation answer instead.
  let check = sb.from('messages').select('id').gt('id', incoming.id).neq('user_id', userId).limit(1)
  check = isDirect ? check.eq('user_id', incoming.user_id).eq('recipient_id', userId) : check.is('recipient_id', null)
  const { data: newer } = await check
  if (newer?.length) return

  const { error: postError } = await sb
    .from('messages')
    .insert({ content: text.slice(0, 4000), recipient_id: isDirect ? incoming.user_id : null })
  if (postError) throw postError
}
