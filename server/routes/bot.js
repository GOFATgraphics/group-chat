// The chat's AI members (e.g. adam and ali), running entirely on Vercel.
//
// Supabase POSTs every new message a bot may read (group messages and private
// messages to that bot; see the agent_webhooks migration) to this function,
// once per bot, each with that bot's own secret. The secret tells us which
// bot the delivery is for. We acknowledge at once, then ask Claude for that
// bot's reply and post it as the bot, so replies land within seconds.
//
// GET /api/bot (open it once in a browser after deploying) registers this
// function's production URL as every configured bot's webhook and reports
// the setup status.
//
// Claude is reached one of two ways:
//   - Vercel AI Gateway (default): no key needed. On a Vercel deployment the
//     function authenticates with Vercel's built-in OIDC token and usage is
//     billed to the Vercel team as AI Gateway credits.
//   - Anthropic directly: set ANTHROPIC_API_KEY.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   BOTS                      comma-separated chat usernames, e.g. adam,ali
//   BOT_PASSWORD_<USERNAME>   each bot's chat password, e.g. BOT_PASSWORD_ADAM
//   BOT_PERSONA_<USERNAME>    optional, overrides the text in server/personas.js
//   BOT_MODEL                 optional, default Claude Opus 5.5
//                             (anthropic/claude-opus-5.5 via AI Gateway, which also
//                             offers other providers' models, e.g. google/...)
//   ANTHROPIC_API_KEY         optional, call Anthropic directly instead of AI Gateway
//   AI_GATEWAY_API_KEY        optional, an AI Gateway key instead of the OIDC token
//   BOT_EFFORT                optional: low | medium | high, default low (fastest)
//   (BOT_USERNAME + BOT_PASSWORD, the single-bot form, still work too.)

import Anthropic from '@anthropic-ai/sdk'
import { waitUntil } from '@vercel/functions'
import { getVercelOidcToken } from '@vercel/oidc'
import { timingSafeEqual } from 'node:crypto'
import { client, usernameToEmail, markRead, broadcastTyping, HttpError, BUCKET } from '../lib.js'
import { PERSONAS, defaultPersona } from '../personas.js'
import { speak, transcribeAudio, voiceFor } from '../speech.js'

const GATEWAY_URL = 'https://ai-gateway.vercel.sh'
const useGateway = () => !process.env.ANTHROPIC_API_KEY
const model = () => process.env.BOT_MODEL || (useGateway() ? 'anthropic/claude-opus-5.5' : 'claude-opus-5-5')
const EFFORT = process.env.BOT_EFFORT || 'low'
const HISTORY = 40
const NO_REPLY = 'NO_REPLY'
// Bots stay quiet when this many messages in a row in a conversation are
// all from bots, so two AI members can never keep a conversation going alone.
const MAX_BOT_STREAK = 4

// Called while the incoming request is in scope: the OIDC token is read from
// the request context and must not be cached.
async function llmClient() {
  if (!useGateway()) return new Anthropic()
  const apiKey = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken().catch(() => ''))
  if (!apiKey) throw new HttpError(500, 'No AI credentials: deploy on Vercel (OIDC), or set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY')
  return new Anthropic({ apiKey, baseURL: GATEWAY_URL })
}

const envKey = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_')

function configuredBots() {
  const names = new Set(
    (process.env.BOTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  const legacy = process.env.BOT_USERNAME?.trim().toLowerCase()
  if (legacy) names.add(legacy)
  return [...names].map((name) => ({
    name,
    password: process.env[`BOT_PASSWORD_${envKey(name)}`] || (name === legacy ? process.env.BOT_PASSWORD : undefined),
    persona: process.env[`BOT_PERSONA_${envKey(name)}`] || PERSONAS[name] || defaultPersona(name),
  }))
}

// Bot sessions, reused while this function instance stays warm.
const sessions = new Map()

async function botSession(bot, { fresh = false } = {}) {
  const hit = sessions.get(bot.name)
  if (!fresh && hit && hit.expiresAt - 60 > Date.now() / 1000) return hit
  if (!bot.password) throw new HttpError(500, `Set BOT_PASSWORD_${envKey(bot.name)} in Vercel`)
  const { data, error } = await client().auth.signInWithPassword({ email: usernameToEmail(bot.name), password: bot.password })
  if (error) throw new HttpError(500, `Login failed for "${bot.name}": ${error.message}`)
  const sb = client(data.session.access_token)
  const { data: hook } = await sb.from('agent_webhooks').select('url, secret').maybeSingle()
  const session = { ...bot, sb, token: data.session.access_token, userId: data.user.id, expiresAt: data.session.expires_at, hook }
  sessions.set(bot.name, session)
  return session
}

function secretMatches(header, secret) {
  if (!secret || !header?.startsWith('Bearer ')) return false
  const a = Buffer.from(header.slice(7))
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Which bot is this delivery for? Checked against each bot's webhook secret.
async function botFor(header) {
  const bots = configuredBots()
  for (const fresh of [false, true]) {
    const all = await Promise.all(bots.map((b) => botSession(b, { fresh })))
    const match = all.find((s) => secretMatches(header, s.hook?.secret))
    if (match) return match
  }
  return null
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.status(200).json(await setup())
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    if (!configuredBots().length) return res.status(500).json({ error: 'Set BOTS in Vercel, e.g. adam,ali' })

    const bot = await botFor(req.headers.authorization)
    if (!bot) return res.status(401).json({ error: 'Bad secret' })

    const message = req.body?.message
    if (req.body?.type !== 'message.created' || !message?.id) return res.status(400).json({ error: 'Unexpected payload' })

    // Acknowledge immediately (Supabase waits at most 5 s), then do the work.
    const llm = await llmClient()
    waitUntil(respond(bot, message, llm).catch((err) => console.error(`${bot.name} reply failed`, err)))
    return res.status(202).json({ ok: true, bot: bot.name })
  } catch (err) {
    console.error(err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}

// Points every bot's webhook at this deployment's production URL.
async function setup() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
  const url = host ? `https://${host}/api/bot` : null
  const bots = await Promise.all(
    configuredBots().map(async (b) => {
      try {
        const s = await botSession(b)
        if (url && s.hook?.url !== url) {
          const { error } = await s.sb.from('agent_webhooks').upsert({ user_id: s.userId, url }, { onConflict: 'user_id' })
          if (error) throw new Error(`Could not register webhook: ${error.message}`)
          await botSession(b, { fresh: true })
        }
        return { name: b.name, webhook: url ?? s.hook?.url ?? null, ok: true }
      } catch (err) {
        return { name: b.name, ok: false, error: err.message }
      }
    }),
  )
  let ai
  try {
    await llmClient()
    ai = { ok: true, via: useGateway() ? 'Vercel AI Gateway' : 'Anthropic API key', model: model() }
  } catch (err) {
    ai = { ok: false, error: err.message }
  }
  return {
    ai,
    bots,
    ready: ai.ok && bots.length > 0 && bots.every((b) => b.ok),
    ...(url ? {} : { note: 'Not a Vercel production deployment; webhooks left unchanged' }),
  }
}

async function respond(bot, incoming, llm) {
  const { sb, userId } = bot
  const isDirect = Boolean(incoming.recipient_id)

  // The conversation this message belongs to, as this bot can see it.
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
  const botNames = new Set(configuredBots().map((b) => b.name))
  const isBot = (id) => botNames.has(names[id])
  const nameOf = (id) => (id === userId ? `${bot.name} (you)` : names[id] ?? 'someone')

  await markRead(sb, userId, history)

  // Loop guards between AI members.
  if (isBot(incoming.user_id)) {
    if (isDirect) return
    const mentioned = new RegExp(`\\b${bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(incoming.content ?? '')
    if (!mentioned) return
  }
  const tail = history.slice(-MAX_BOT_STREAK)
  if (tail.length === MAX_BOT_STREAK && tail.every((m) => isBot(m.user_id))) return

  // A newer message from a person will trigger its own reply with fuller
  // context, so skip this one instead of answering twice.
  const newestFromPeople = history.filter((m) => m.user_id !== userId && !isBot(m.user_id)).at(-1)
  if (newestFromPeople && newestFromPeople.id > incoming.id) return

  // A voice note: hear it (speech-to-text), and answer it with a voice note.
  const incomingIsVoice = Boolean(incoming.attachment_type?.startsWith('audio/'))
  let heard = null
  if (incomingIsVoice) {
    try {
      const { data: blob } = await sb.storage.from(BUCKET).download(incoming.attachment_path)
      if (blob) heard = (await transcribeAudio(new Uint8Array(await blob.arrayBuffer()), incoming.attachment_type)).text
    } catch (err) {
      console.error('transcription failed', err.message)
    }
  }

  const transcript = history
    .map((m) => {
      const parts = [`[#${m.id}] ${nameOf(m.user_id)}`]
      if (m.reply_to_id) parts.push(`(replying to #${m.reply_to_id})`)
      let line = `${parts.join(' ')}: ${m.content ?? ''}`
      if (m.attachment_type?.startsWith('audio/')) {
        line +=
          m.id === incoming.id && heard
            ? ` [voice note; they said: "${heard}"]`
            : ' [voice note]'
      }
      else if (m.attachment_name) line += ` [attached ${m.attachment_type?.startsWith('image/') ? 'photo' : 'file'}: ${m.attachment_name}]`
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
  const otherBots = [...botNames].filter((n) => n !== bot.name)
  const system =
    `${bot.persona}\n\n` +
    `Your username in the chat is "${bot.name}". The members are: ${members}.\n` +
    (otherBots.length ? `${otherBots.join(', ')} ${otherBots.length > 1 ? 'are' : 'is'} also an AI member like you; don't drag them into back-and-forth chatter.\n` : '') +
    `Each request shows the recent conversation, one message per line as "[#id] name: text". ` +
    `Reply with only the text of your next chat message: no "[#id]", no name prefix, no quotes.` +
    (isDirect
      ? ''
      : `\nIn the group chat, not every message needs you. If the newest message is clearly meant for ` +
        `someone else, someone else has already answered it, it is a conversation you have nothing to add to, ` +
        `or it just wraps up a topic, reply with exactly ${NO_REPLY} and nothing else. Always answer when ` +
        `someone mentions you by name, asks you something, or replies to one of your messages.`)

  // Show "typing…" while Claude writes the reply (it lasts ~6 s per event),
  // in the group chat as well as in private chats, exactly like a human
  // member typing. Previously this only ran in the group when the bot was
  // named, so most bot replies arrived with no bubble at all. Now it runs
  // for every delivery the bot processes, and stopTyping() below hides it
  // again when the bot decides not to reply, just as a human deleting a
  // draft hides their bubble.
  const typingTo = isDirect ? incoming.user_id : null
  const showTyping = () => broadcastTyping(bot.token, userId, typingTo).catch(() => {})
  showTyping()
  const typingTimer = setInterval(showTyping, 4000)

  const request = {
    model: model(),
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT },
    system,
    messages: [{ role: 'user', content }],
  }
  // Direct to Anthropic: on a safety decline, retry on another Claude model
  // server-side (AI Gateway applies its own provider routing instead).
  let response
  try {
    response = useGateway()
      ? await llm.messages.create(request)
      : await llm.beta.messages.create({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
  } finally {
    clearInterval(typingTimer)
  }
  const stopTyping = () => broadcastTyping(bot.token, userId, typingTo, false).catch(() => {})
  if (response.stop_reason === 'refusal') return stopTyping()

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text || text === NO_REPLY) return stopTyping()

  // Still the latest? If a person wrote again while Claude was thinking, let
  // that message's own delivery answer instead.
  let check = sb.from('messages').select('id, user_id').gt('id', incoming.id).neq('user_id', userId).limit(20)
  check = isDirect ? check.eq('user_id', incoming.user_id).eq('recipient_id', userId) : check.is('recipient_id', null)
  const { data: newer } = await check
  if (newer?.some((m) => !isBot(m.user_id))) return stopTyping()

  let reply = { content: text.slice(0, 4000) }
  if (incomingIsVoice) {
    try {
      const voice = await speak(text, voiceFor(bot.name))
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-voice-note.mp3`
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, voice.bytes, { contentType: voice.type })
      if (upErr) throw upErr
      reply = {
        content: null,
        attachment_path: path,
        attachment_name: voice.name,
        attachment_type: voice.type,
        attachment_size: voice.bytes.length,
        attachment_duration: voice.duration,
      }
    } catch (err) {
      console.error('voice reply failed, sending text instead', err.message)
    }
  }
  const { error: postError } = await sb
    .from('messages')
    .insert({ ...reply, recipient_id: isDirect ? incoming.user_id : null })
  if (postError) throw postError
}
