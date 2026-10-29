// Speech for AI members, through Vercel AI Gateway (no provider key needed on
// Vercel: the AI SDK signs in with the deployment's OIDC token; usage is
// billed to the Vercel team as AI Gateway credits).
//   speak(): text -> MP3 voice note, so an agent can answer a voice note
//            with a voice note (POST /api/messages { "as_voice": true }).
//   transcribeAudio(): voice note -> text (GET /api/messages/:id?transcribe=1).

import { generateSpeech, transcribe } from 'ai'
import { HttpError } from './lib.js'

const TTS_MODEL = process.env.TTS_MODEL || 'openai/tts-1'
const STT_MODEL = process.env.STT_MODEL || 'openai/whisper-1'
const MAX_SPEECH_CHARS = 4000

// A different voice for each AI member; override with VOICE_<USERNAME>.
const DEFAULT_VOICES = { adam: 'onyx', ali: 'echo' }
export function voiceFor(username, requested) {
  const key = `VOICE_${String(username ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  return requested || process.env[key] || DEFAULT_VOICES[username] || 'alloy'
}

export async function speak(text, voice) {
  const clean = String(text ?? '').trim()
  if (!clean) throw new HttpError(400, 'as_voice needs "text" to speak')
  if (clean.length > MAX_SPEECH_CHARS) throw new HttpError(400, `Voice replies are limited to ${MAX_SPEECH_CHARS} characters`)
  let result
  try {
    result = await generateSpeech({ model: TTS_MODEL, text: clean, voice, outputFormat: 'mp3' })
  } catch (err) {
    throw new HttpError(502, `Text-to-speech failed: ${err.message}`)
  }
  const bytes = Buffer.from(result.audio.uint8Array)
  return { bytes, type: 'audio/mpeg', name: 'voice-note.mp3', duration: mp3Duration(bytes) }
}

export async function transcribeAudio(bytes, mediaType) {
  try {
    const result = await transcribe({ model: STT_MODEL, audio: bytes, providerOptions: {} })
    return { text: result.text, language: result.language ?? null }
  } catch (err) {
    throw new HttpError(502, `Transcription failed: ${err.message} (${mediaType})`)
  }
}

// Length of an MP3 in seconds, from its frame headers (so the player can show
// it). Walks every frame, which also handles variable bit rates.
const BITRATES = {
  // MPEG-1 Layer III, MPEG-2/2.5 Layer III (kbps)
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

export function mp3Duration(buf) {
  let i = 0
  // skip an ID3v2 tag
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    i = 10 + ((buf[6] & 0x7f) << 21) + ((buf[7] & 0x7f) << 14) + ((buf[8] & 0x7f) << 7) + (buf[9] & 0x7f)
  }
  let seconds = 0
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++
      continue
    }
    const version = (buf[i + 1] >> 3) & 3 // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (buf[i + 1] >> 1) & 3 // 1 = Layer III
    const bitrateIndex = buf[i + 2] >> 4
    const rateIndex = (buf[i + 2] >> 2) & 3
    const padding = (buf[i + 2] >> 1) & 1
    const sampleRate = SAMPLE_RATES[version]?.[rateIndex]
    const kbps = BITRATES[version === 3 ? 1 : 2][bitrateIndex]
    if (version === 1 || layer !== 1 || !sampleRate || !kbps) {
      i++
      continue
    }
    const samples = version === 3 ? 1152 : 576
    const frameLength = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding
    seconds += samples / sampleRate
    i += Math.max(frameLength, 1)
  }
  return Math.round(seconds * 10) / 10
}
