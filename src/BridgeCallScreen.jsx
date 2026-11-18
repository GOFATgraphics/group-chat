import { useEffect, useRef, useState } from 'react'
import { supabase, BUCKET } from './supabase.js'

// Live voice call with the REAL AI member, turn by turn (the "voice bridge").
//
// The old realtime call spoke through a separate voice model that only
// impersonated the agent — and it is dead on Render (no AI Gateway key, no
// Vercel OIDC). This screen instead uses flows that already work:
//
//   1. You tap the mic and speak. The recording is sent as an ordinary
//      voice-note message, exactly like voice notes in chat.
//   2. The agent gets it like any voice note (she already transcribes them
//      with her own tools) and replies.
//   3. Her reply is spoken back to you: a voice-note reply plays its audio;
//      a text reply is read aloud by the phone/browser (speechSynthesis).
//
// No server endpoint, no new key, no new billing: turns are ordinary
// messages, so usage counts exactly as it does for voice notes and text.

const MAX_TURN_SECONDS = 60
const REPLY_TIMEOUT_MS = 120_000
const MAX_CALL_SECONDS = 30 * 60
const RECORDING_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

// Gauri is female; Adam, Ali and Anurag are male. Unknown agents fall back
// to the first English voice.
const VOICE_KIND = { gauri: 'female', adam: 'male', ali: 'male', anurag: 'male' }
const FEMALE_HINTS = ['samantha', 'zira', 'aria', 'jenny', 'karen', 'moira', 'tessa', 'veena', 'fiona', 'female', 'google us english']
const MALE_HINTS = ['daniel', 'alex', 'david', 'mark', 'fred', 'james', 'aaron', 'male', 'google uk english male']

function pickVoice(username) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null
  const voices = window.speechSynthesis.getVoices() ?? []
  if (!voices.length) return null
  const kind = VOICE_KIND[String(username ?? '').toLowerCase()] ?? null
  const hints = kind === 'female' ? FEMALE_HINTS : kind === 'male' ? MALE_HINTS : []
  const score = (v) => {
    const name = (v.name ?? '').toLowerCase()
    let s = 0
    if (hints.some((h) => name.includes(h))) s += 3
    if (/^en[-_]us/i.test(v.lang ?? '')) s += 2
    else if (/^en[-_]gb/i.test(v.lang ?? '')) s += 2
    else if (/^en/i.test(v.lang ?? '')) s += 1
    return s
  }
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null
}

// Split a reply into short spoken chunks (a sentence, or part of one).
function speechChunks(text) {
  const sentences = String(text ?? '').match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? []
  const chunks = []
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (!trimmed) continue
    if (trimmed.length <= 180) {
      chunks.push(trimmed)
      continue
    }
    for (const part of trimmed.split(/,\s*/)) {
      const p = part.trim()
      if (p) chunks.push(p.length <= 180 ? p : p.slice(0, 180))
    }
  }
  return chunks.length ? chunks : [String(text ?? '').slice(0, 180)]
}

const formatClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function BridgeCallScreen({ peer, avatar, myName, myId, messages, urls, send, onEnded, agentTyping, agentWorking }) {
  const [phase, setPhase] = useState('idle') // idle | recording | waiting | speaking | noreply
  const [elapsed, setElapsed] = useState(0)
  const [turnElapsed, setTurnElapsed] = useState(0)
  const [levels, setLevels] = useState(() => Array(24).fill(0.08))
  const [error, setError] = useState('')
  const [caption, setCaption] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [speechOn, setSpeechOn] = useState(typeof window !== 'undefined' && 'speechSynthesis' in window)
  const [queue, setQueue] = useState([]) // peer replies waiting to be spoken, oldest first

  const startedAt = useRef(Date.now())
  const ended = useRef(false)
  const rec = useRef(null) // { recorder, stream, ctx, chunks, startedAt, mime, auto, hadSpeech, lastLoudAt }
  const audio = useRef(null)
  const speechToken = useRef(0) // cancels a stale speak chain
  const replyTimer = useRef(null)
  const autoListenTimer = useRef(null)
  const turns = useRef([]) // { from: 'me' | peer.username, text } for the call card
  const seenIds = useRef(new Set((messages ?? []).map((m) => m.id)))
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // Prime the speech engine on mount so voices are loaded when needed.
  useEffect(() => {
    if (!window.speechSynthesis) return
    const load = () => setSpeechOn(true)
    window.speechSynthesis.getVoices()
    window.speechSynthesis.addEventListener?.('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', load)
  }, [])

  // Call timer; the bridge has no per-minute server cost, so the cap is a
  // sane 30 minutes, not the realtime call's 10.
  useEffect(() => {
    const t = setInterval(() => {
      const secs = (Date.now() - startedAt.current) / 1000
      setElapsed(secs)
      if (secs >= MAX_CALL_SECONDS) hangUp()
    }, 500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stop everything on unmount (hang-up already does this too).
  useEffect(
    () => () => {
      stopRecording(true)
      stopSpeaking()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  function stopRecording(silent) {
    const r = rec.current
    if (!r) return
    rec.current = null
    try {
      if (r.recorder.state !== 'inactive') r.recorder.stop()
    } catch {
      // already stopped
    }
    r.stream.getTracks().forEach((t) => t.stop())
    r.ctx?.close?.().catch(() => {})
    if (!silent) setLevels(Array(24).fill(0.08))
  }

  function stopSpeaking() {
    speechToken.current += 1
    try {
      window.speechSynthesis?.cancel()
    } catch {
      // no speech engine
    }
    if (audio.current) {
      try {
        audio.current.pause()
      } catch {
        // already gone
      }
      audio.current = null
    }
    setSpeaking(false)
  }

  // ---- recording ------------------------------------------------------------
  // auto: this turn started itself after a reply (hands-free). An auto turn
  // that hears no speech within 8 s gives up quietly instead of sending
  // silence to the agent.

  async function startRecording(auto = false) {
    if (phaseRef.current === 'recording') return
    clearTimeout(autoListenTimer.current)
    stopSpeaking()
    setError('')
    setCaption('')
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Microphone access is blocked. Allow it in your browser or phone settings to talk.'
          : 'Could not start the microphone.',
      )
      return
    }
    // Speaking needs a user gesture to unlock on iPhone; the mic tap is one.
    // A silent warm-up utterance unlocks speechSynthesis for the replies
    // that arrive later, outside any tap.
    try {
      const warm = new SpeechSynthesisUtterance(' ')
      warm.volume = 0
      window.speechSynthesis?.speak(warm)
    } catch {
      // speech still works (or not) without the warm-up
    }
    const mime = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? ''
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const chunks = []
    recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data)
    recorder.start(250)
    let ctx = null
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      ctx = new AC()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const levelTimer = setInterval(() => {
        if (!rec.current) return clearInterval(levelTimer)
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const v of data) sum += ((v - 128) / 128) ** 2
        const level = Math.min(1, Math.sqrt(sum / data.length) * 4)
        if (level > 0.25) {
          rec.current.hadSpeech = true
          rec.current.lastLoudAt = Date.now()
        }
        setLevels((prev) => [...prev.slice(1), Math.max(0.08, level)])
      }, 90)
    } catch {
      // No level meter on this browser; recording still works.
    }
    rec.current = {
      recorder,
      stream,
      ctx,
      chunks,
      startedAt: Date.now(),
      mime: recorder.mimeType || mime,
      auto,
      hadSpeech: false,
      lastLoudAt: Date.now(),
    }
    setTurnElapsed(0)
    setPhase('recording')
    const tick = setInterval(() => {
      const r = rec.current
      if (!r) return clearInterval(tick)
      const secs = (Date.now() - r.startedAt) / 1000
      setTurnElapsed(secs)
      if (secs >= MAX_TURN_SECONDS) return finishRecording()
      // Spoke, then went quiet: send without waiting for a tap.
      if (r.hadSpeech && Date.now() - r.lastLoudAt > 1500) return finishRecording()
      // Auto turn, nothing said: give up quietly, don't send silence.
      if (r.auto && !r.hadSpeech && secs > 8) return stopAutoListen()
    }, 250)
  }

  // An auto-started turn heard nothing: stop and wait for a tap.
  function stopAutoListen() {
    stopRecording(true)
    setPhase('idle')
  }

  async function finishRecording() {
    const r = rec.current
    if (!r) return
    const duration = (Date.now() - r.startedAt) / 1000
    const stopped = new Promise((resolve) => {
      r.recorder.onstop = resolve
    })
    try {
      r.recorder.requestData?.()
    } catch {
      // not recording any more
    }
    stopRecording()
    await stopped
    // Nothing was actually said: discard, don't send silence to the agent.
    if (!r.hadSpeech) {
      setPhase('idle')
      return
    }
    const type = (r.mime || r.chunks[0]?.type || 'audio/webm').split(';')[0]
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
    const blob = new Blob(r.chunks, { type })
    if (duration < 0.5 || !blob.size) {
      setError('That was too short to send. Tap the mic and try again.')
      setPhase('idle')
      return
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = new File([blob], `voice-note-${stamp}.${ext}`, { type })
    // Remember which messages already exist, so only the agent's NEW reply
    // to this turn gets spoken — not anything she said before the call.
    seenIds.current = new Set((messages ?? []).map((m) => m.id))
    const ok = await send({ file, duration: Math.round(duration * 10) / 10 })
    if (!ok) {
      setError("That didn't send. Tap the mic to try again.")
      setPhase('idle')
      return
    }
    turns.current.push({ from: 'me', text: '[voice note]' })
    setPhase('waiting')
    setTurnElapsed(0)
    clearTimeout(replyTimer.current)
    replyTimer.current = setTimeout(() => {
      if (phaseRef.current === 'waiting') setPhase('noreply')
    }, REPLY_TIMEOUT_MS)
  }

  // A reply finished playing: listen for the next turn by itself, so a
  // call feels like a conversation instead of a tap per turn. Fires only
  // when the screen is still idle 600 ms later (a queued reply, a manual
  // tap, or hang-up all cancel it).
  function scheduleAutoListen() {
    clearTimeout(autoListenTimer.current)
    autoListenTimer.current = setTimeout(() => {
      if (ended.current) return
      if (phaseRef.current !== 'idle') return
      startRecording(true)
    }, 600)
  }

  function finishSpeaking() {
    setSpeaking(false)
    setPhase('idle')
    scheduleAutoListen()
  }

  // ---- replies ---------------------------------------------------------------

  // New messages from the peer, in arrival order. Anything already seen
  // (before the call, or before the turn) is ignored, and so is any older
  // history that loads late — only messages created after the call started
  // can be replies on this call.
  useEffect(() => {
    const fresh = (messages ?? []).filter(
      (m) =>
        m.user_id === peer.id &&
        !seenIds.current.has(m.id) &&
        m.call_duration == null &&
        new Date(m.created_at).getTime() > startedAt.current - 5000,
    )
    if (!fresh.length) return
    for (const m of fresh) seenIds.current.add(m.id)
    setQueue((prev) => [...prev, ...fresh])
    clearTimeout(replyTimer.current)
  }, [messages, peer.id])

  // Speak the next queued reply when nothing else is using the mic/speaker.
  useEffect(() => {
    if (!queue.length || phaseRef.current === 'recording') return
    if (phaseRef.current === 'speaking') return
    const next = queue[0]
    setQueue((prev) => prev.slice(1))
    speakReply(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, phase])

  async function speakReply(msg) {
    setPhase('speaking')
    setSpeaking(true)
    const isVoice = msg.attachment_path && (msg.attachment_type ?? '').startsWith('audio/')
    if (isVoice) {
      setCaption(`${peer.username} sent a voice reply`)
      turns.current.push({ from: peer.username, text: '[voice note]' })
      const url = urls?.[msg.attachment_path] ?? msg._localUrl ?? (await signedUrl(msg.attachment_path))
      if (!url) {
        setSpeaking(false)
        setPhase('idle')
        return
      }
      const a = new Audio(url)
      audio.current = a
      a.onended = () => {
        audio.current = null
        finishSpeaking()
      }
      a.onerror = () => {
        audio.current = null
        setSpeaking(false)
        setError("Couldn't play that voice reply. Read it in the chat instead.")
        setPhase('idle')
      }
      try {
        await a.play()
      } catch {
        audio.current = null
        setSpeaking(false)
        setError("Couldn't play that voice reply. Tap the speaker to try again.")
        setPhase('idle')
      }
      return
    }
    const text = (msg.content ?? '').trim()
    if (!text) {
      finishSpeaking()
      return
    }
    setCaption(text)
    turns.current.push({ from: peer.username, text })
    if (!window.speechSynthesis) {
      setSpeaking(false)
      setPhase('idle')
      return
    }
    const token = ++speechToken.current
    const voice = pickVoice(peer.username)
    const chunks = speechChunks(text)
    let i = 0
    const sayNext = () => {
      if (token !== speechToken.current) return // cancelled / hung up
      if (i >= chunks.length) {
        finishSpeaking()
        return
      }
      const u = new SpeechSynthesisUtterance(chunks[i])
      i += 1
      if (voice) u.voice = voice
      u.rate = 1
      u.onend = sayNext
      u.onerror = () => {
        if (token !== speechToken.current) return
        setSpeaking(false)
        setError("Couldn't speak that reply. Tap the speaker to hear it.")
        setPhase('idle')
      }
      try {
        window.speechSynthesis.speak(u)
      } catch {
        setSpeaking(false)
        setPhase('idle')
      }
    }
    sayNext()
  }

  async function signedUrl(path) {
    try {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600)
      return data?.signedUrl ?? null
    } catch {
      return null
    }
  }

  // ---- hang-up ----------------------------------------------------------------

  function hangUp() {
    if (ended.current) return
    ended.current = true
    clearTimeout(replyTimer.current)
    clearTimeout(autoListenTimer.current)
    stopRecording(true)
    stopSpeaking()
    const duration = Math.round((Date.now() - startedAt.current) / 1000)
    const transcript = turns.current.map((t) => `${t.from === 'me' ? myName : t.from}: ${t.text}`).join('\n')
    onEnded({ duration, transcript })
  }

  function testVoice() {
    setError('')
    if (!window.speechSynthesis) {
      setError('This browser cannot speak replies aloud. You can still read them in the chat.')
      return
    }
    stopSpeaking()
    const voice = pickVoice(peer.username)
    const u = new SpeechSynthesisUtterance(`Hi, I'm ${peer.username}. Tap the mic and talk to me.`)
    if (voice) u.voice = voice
    try {
      window.speechSynthesis.speak(u)
      setCaption(`Hi, I'm ${peer.username}. Tap the mic and talk to me.`)
    } catch {
      setError("Couldn't play the voice test.")
    }
  }

  const status =
    phase === 'recording'
      ? `Listening… ${formatClock(turnElapsed)}`
      : phase === 'waiting'
        ? agentWorking
          ? agentWorking
          : agentTyping
            ? `${peer.username} is typing…`
            : `Waiting for ${peer.username}…`
        : phase === 'speaking'
          ? `${peer.username} is speaking`
          : phase === 'noreply'
            ? `No reply from ${peer.username} yet`
            : `Live call · ${formatClock(elapsed)}`

  const micLabel =
    phase === 'recording' ? 'Tap to send' : phase === 'waiting' || phase === 'speaking' ? 'Talk' : 'Tap to talk'

  return (
    <div className="call-screen" role="dialog" aria-modal="true" aria-label={`Call with ${peer.username}`}>
      <div className="call-top">
        <div className={`call-avatar ${speaking ? 'speaking' : ''}`}>
          {avatar ? <img src={avatar} alt="" /> : <span>{peer.username.slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="call-name">{peer.username}</div>
        <div className="call-status" aria-live="polite">
          {status}
        </div>
        {error && <div className="call-error">{error}</div>}
        {caption && <div className="call-caption">{caption}</div>}
        {phase === 'recording' && (
          <div className="call-levels" aria-hidden="true">
            {levels.map((l, i) => (
              <span key={i} style={{ height: `${Math.round(4 + l * 22)}px` }} />
            ))}
          </div>
        )}
        {phase === 'noreply' && (
          <button className="call-sound-hint" onClick={() => setPhase('idle')}>
            Try talking again
          </button>
        )}
      </div>
      <div className="call-controls">
        <button
          className={`call-btn ${phase === 'recording' ? 'on' : ''}`}
          onClick={() => (phase === 'recording' ? finishRecording() : startRecording())}
          aria-label={micLabel}
          aria-pressed={phase === 'recording'}
          disabled={phase === 'waiting'}
        >
          <MicIcon off={false} />
          <span>{micLabel}</span>
        </button>
        <button className="call-btn" onClick={testVoice} aria-label={`Hear ${peer.username}'s voice`}>
          <SpeakerIcon />
          <span>Hear voice</span>
        </button>
        <button className="call-btn end" onClick={hangUp} aria-label="End call">
          <HangUpIcon />
        </button>
      </div>
    </div>
  )
}

const HangUpIcon = () => (
  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
    <path
      d="M3.5 14.2c4.7-4.3 12.3-4.3 17 0l-2.1 2.6c-.4.5-1.1.6-1.6.3l-2.3-1.4c-.4-.3-.6-.8-.5-1.3l.3-1.4a11 11 0 0 0-4.6 0l.3 1.4c.1.5-.1 1-.5 1.3l-2.3 1.4c-.5.3-1.2.2-1.6-.3z"
      fill="currentColor"
    />
  </svg>
)
const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <path d="M4 9v6h4l5 4.5v-15L8 9H4z" fill="currentColor" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
