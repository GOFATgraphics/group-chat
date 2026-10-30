// Live voice calls with AI members, through Vercel AI Gateway's realtime models.
// Audio streams directly between the caller's browser and AI Gateway; Vercel
// only takes part for a moment at the start:
//
//   POST /api/call/start  { "peer": "adam" }        (signed-in member)
//     -> checks the peer is an AI member, builds its call instructions (its
//        personality plus your recent private chat) and returns a signed
//        60-second ticket and the session settings.
//   POST /api/call/token?ticket=...                 (called by the browser's
//     realtime session, which can't send a login) -> verifies the ticket and
//     mints a short-lived AI Gateway client secret: { token, url }.
//
// After hanging up, the app saves the transcript as a message to the AI
// (messages.call_duration set), so the AI's text agent knows what was said.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { gateway } from '@ai-sdk/gateway'
import { getVercelOidcToken } from '@vercel/oidc'
import { route, auth, body, check, HttpError } from '../lib.js'
import { PERSONAS, defaultPersona } from '../personas.js'
import { speak, transcribeAudio } from '../speech.js'

export const CALL_MODEL = process.env.CALL_MODEL || 'openai/gpt-realtime-2'
export const CALL_MAX_SECONDS = Math.min(30, Number(process.env.CALL_MAX_MINUTES) || 10) * 60
const TICKET_SECONDS = 60
const CONTEXT_MESSAGES = 30

// Realtime voices differ from text-to-speech voices; one per AI member.
const CALL_VOICES = { adam: 'ash', ali: 'verse' }
const callVoiceFor = (name) =>
  process.env[`CALL_VOICE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || CALL_VOICES[name] || 'alloy'

function ticketKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  if (!key) throw new HttpError(500, 'Calls need SUPABASE_SERVICE_ROLE_KEY set in Vercel')
  return key
}
const sign = (data) => createHmac('sha256', ticketKey()).update(`call-ticket:${data}`).digest('base64url')

export function makeTicket(claims) {
  const data = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + TICKET_SECONDS })).toString('base64url')
  return `${data}.${sign(data)}`
}

export function readTicket(ticket) {
  const [data, mac] = String(ticket ?? '').split('.')
  if (!data || !mac) throw new HttpError(401, 'Missing call ticket')
  const expected = Buffer.from(sign(data))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(401, 'Invalid call ticket')
  const claims = JSON.parse(Buffer.from(data, 'base64url').toString())
  if (!claims.exp || claims.exp < Date.now() / 1000) throw new HttpError(401, 'Call ticket expired; start the call again')
  return claims
}

const start = route({
  async POST(req) {
    const { sb, userId } = await auth(req)
    const { peer } = body(req)
    if (!peer) throw new HttpError(400, 'peer (the AI member to call) is required')
    const profiles = check(await sb.from('profiles').select('id, username, is_ai'))
    const me = profiles.find((p) => p.id === userId)
    const ai = profiles.find((p) => p.username === String(peer).trim().toLowerCase())
    if (!me) throw new HttpError(403, 'Not a chat member')
    if (!ai) throw new HttpError(404, `No member named "${peer}"`)
    if (!ai.is_ai) throw new HttpError(403, 'Live calls are only available with AI members')

    // Recent private conversation, so the AI knows what you were talking about.
    const recent = check(
      await sb
        .from('messages')
        .select('user_id, content, attachment_type, call_duration, created_at')
        .or(`and(user_id.eq.${userId},recipient_id.eq.${ai.id}),and(user_id.eq.${ai.id},recipient_id.eq.${userId})`)
        .order('id', { ascending: false })
        .limit(CONTEXT_MESSAGES),
    ).reverse()
    const who = (id) => (id === ai.id ? ai.username : me.username)
    const history = recent
      .map((m) => {
        if (m.call_duration != null) return `${who(m.user_id)}: [an earlier voice call]`
        if (m.attachment_type?.startsWith('audio/')) return `${who(m.user_id)}: [voice note]`
        if (m.attachment_type?.startsWith('image/')) return `${who(m.user_id)}: [photo] ${m.content ?? ''}`
        return m.content ? `${who(m.user_id)}: ${m.content.slice(0, 500)}` : null
      })
      .filter(Boolean)
      .join('\n')

    const persona = process.env[`BOT_PERSONA_${ai.username.toUpperCase()}`] || PERSONAS[ai.username] || defaultPersona(ai.username)
    const minutes = Math.round(CALL_MAX_SECONDS / 60)
    const instructions =
      `${persona}\n\n` +
      `You are on a live voice call with ${me.username}, a member of your group chat. ` +
      `Talk like a real phone call: short, warm, natural sentences, one idea at a time, and let them speak. ` +
      `Never read out lists, markdown, links or emoji. Answer in the language ${me.username} speaks. ` +
      `Start by greeting ${me.username} by name in one short sentence. ` +
      `Calls last at most ${minutes} minutes; if you are told time is almost up, wrap up kindly and say goodbye.` +
      (history ? `\n\nYour recent private messages with ${me.username} (oldest first):\n${history}` : '')

    return {
      ticket: makeTicket({ u: userId, p: ai.id, m: CALL_MODEL }),
      model: CALL_MODEL,
      peer: { id: ai.id, username: ai.username },
      maxSeconds: CALL_MAX_SECONDS,
      sessionConfig: {
        instructions,
        voice: callVoiceFor(ai.username),
        turnDetection: { type: 'semantic-vad' },
        inputAudioTranscription: { model: process.env.CALL_TRANSCRIBE_MODEL || 'whisper-1' },
      },
    }
  },
})

// Turns AI Gateway failures into a short reason people can act on.
function explain(err) {
  const text = `${err?.message ?? err} ${err?.cause?.message ?? ''} ${JSON.stringify(err?.responseBody ?? err?.data ?? '')}`
  const status = err?.statusCode ?? err?.status ?? err?.cause?.statusCode
  if (/only be minted with a Gateway API key/i.test(text)) {
    return 'Live calls need an AI Gateway API key: create one in Vercel → AI Gateway → API Keys and add it to the project as AI_GATEWAY_API_KEY, then redeploy.'
  }
  if (/insufficient|credit|balance|payment|billing|402/i.test(text) || status === 402) {
    return 'AI Gateway has no credits. Add credits in Vercel → AI Gateway (they work right away, no redeploy needed).'
  }
  if (status === 401 || status === 403 || /auth|unauthor|forbidden|oidc|api key/i.test(text)) {
    return `AI Gateway refused the request (${status ?? 'auth'}): ${err.message}`
  }
  return `AI Gateway error${status ? ` ${status}` : ''}: ${err.message}`
}

const token = route({
  async POST(req) {
    const claims = readTicket(req.query.ticket)
    try {
      const { token: secret, url } = await gateway.experimental_realtime.getToken({ model: claims.m })
      return { token: secret, url, tools: [] }
    } catch (err) {
      console.error('realtime token failed', err)
      throw new HttpError(502, `Could not start the call. ${explain(err)}`)
    }
  },
})

// GET /api/call/check (also /api/ai/check): what can this deployment do
// with Vercel AI Gateway right now? Tries each AI feature with a tiny request
// (nothing is returned or stored) and reads the credit balance. Safe to open
// in a browser; it never returns a usable token.
const checkRoute = route({
  async GET() {
    const out = {
      auth: process.env.AI_GATEWAY_API_KEY ? 'AI Gateway API key' : 'Vercel OIDC (no AI_GATEWAY_API_KEY set)',
    }
    const attempt = async (name, fn) => {
      try {
        await fn()
        out[name] = 'ok'
      } catch (err) {
        console.error(`ai check ${name} failed`, err)
        out[name] = explain(err)
      }
    }
    await Promise.all([
      attempt('live_calls', () => gateway.experimental_realtime.getToken({ model: CALL_MODEL })),
      attempt('voice_replies', () => speak('ok', 'alloy')),
      attempt('transcription', () => transcribeAudio(SILENT_WAV, 'audio/wav')),
    ])
    try {
      const key = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken().catch(() => ''))
      const res = await fetch('https://ai-gateway.vercel.sh/v1/credits', { headers: { Authorization: `Bearer ${key}` } })
      out.credits = res.ok ? await res.json() : `HTTP ${res.status}`
    } catch (err) {
      out.credits = `unavailable: ${err.message}`
    }
    out.ready = ['live_calls', 'voice_replies', 'transcription'].every((k) => out[k] === 'ok')
    return out
  },
})

// 0.25 s of silence, 16 kHz mono 16-bit WAV, for the transcription check.
const SILENT_WAV = (() => {
  const samples = 4000
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  return new Uint8Array(buf)
})()

export default { start, token, check: checkRoute }
