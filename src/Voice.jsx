import { useEffect, useRef, useState } from 'react'

// Voice notes: recorded in the browser with MediaRecorder and sent as an
// ordinary audio attachment. The app never transcribes them; people listen,
// and AI members download the audio and transcribe it with their own tools.

const MAX_SECONDS = 5 * 60
// Prefer MP4/AAC: it plays everywhere, including iPhone. Browsers that can't
// record it (e.g. Firefox) fall back to WebM/Ogg Opus.
const RECORDING_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

export const canRecordVoice = () =>
  typeof window !== 'undefined' && 'MediaRecorder' in window && Boolean(navigator.mediaDevices?.getUserMedia)

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---- recording ---------------------------------------------------------------

export function VoiceRecorder({ onSend, onCancel, onError, onTyping }) {
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState(() => Array(28).fill(0.08))
  const [sending, setSending] = useState(false)
  const [ready, setReady] = useState(false)
  const rec = useRef(null) // { recorder, stream, ctx, chunks, startedAt, mime }
  const finishing = useRef(false)

  useEffect(() => {
    let cancelled = false
    let levelTimer = null
    let tickTimer = null

    async function start() {
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      } catch (err) {
        onError?.(
          err?.name === 'NotAllowedError'
            ? 'Microphone access is blocked. Allow it in your browser or phone settings to send voice notes.'
            : 'Could not start the microphone.',
        )
        onCancel()
        return
      }
      if (cancelled) return stream.getTracks().forEach((t) => t.stop())

      const mime = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks = []
      recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data)
      recorder.start(250)

      // Live level meter.
      let ctx = null
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        ctx = new AC()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        levelTimer = setInterval(() => {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (const v of data) sum += ((v - 128) / 128) ** 2
          const level = Math.min(1, Math.sqrt(sum / data.length) * 4)
          setLevels((prev) => [...prev.slice(1), Math.max(0.08, level)])
        }, 90)
      } catch {
        // No level meter on this browser; recording still works.
      }

      rec.current = { recorder, stream, ctx, chunks, startedAt: Date.now(), mime: recorder.mimeType || mime }
      setReady(true)
      tickTimer = setInterval(() => {
        const secs = (Date.now() - rec.current.startedAt) / 1000
        setElapsed(secs)
        onTyping?.(true)
        if (secs >= MAX_SECONDS) finish(true)
      }, 250)
    }
    start()

    return () => {
      cancelled = true
      clearInterval(levelTimer)
      clearInterval(tickTimer)
      release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function release() {
    const r = rec.current
    if (!r) return
    if (r.recorder.state !== 'inactive') {
      try {
        r.recorder.stop()
      } catch {
        // already stopped
      }
    }
    r.stream.getTracks().forEach((t) => t.stop())
    r.ctx?.close?.().catch(() => {})
  }

  function cancel() {
    finishing.current = true
    release()
    onTyping?.(false)
    onCancel()
  }

  async function finish() {
    const r = rec.current
    if (!r || finishing.current) return
    finishing.current = true
    setSending(true)
    const duration = (Date.now() - r.startedAt) / 1000
    const stopped = new Promise((resolve) => {
      r.recorder.onstop = resolve
    })
    try {
      r.recorder.requestData?.()
    } catch {
      // not recording any more
    }
    release()
    await stopped
    const type = (r.mime || r.chunks[0]?.type || 'audio/webm').split(';')[0]
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
    const blob = new Blob(r.chunks, { type })
    if (duration < 0.5 || !blob.size) {
      onError?.('That voice note was too short.')
      onCancel()
      return
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = new File([blob], `voice-note-${stamp}.${ext}`, { type })
    const ok = await onSend({ file, duration: Math.round(duration * 10) / 10 })
    onTyping?.(false)
    if (ok) onCancel()
    else {
      setSending(false)
      finishing.current = false
      onCancel()
    }
  }

  return (
    <div className="voice-recorder" role="group" aria-label="Recording voice note">
      <button type="button" className="circle-btn voice-cancel" onClick={cancel} aria-label="Delete recording" disabled={sending}>
        <TrashIcon />
      </button>
      <div className="voice-recording-pill">
        <span className={`rec-dot ${ready ? 'on' : ''}`} aria-hidden="true" />
        <span className="rec-time">{formatDuration(elapsed)}</span>
        <span className="rec-levels" aria-hidden="true">
          {levels.map((l, i) => (
            <span key={i} style={{ height: `${Math.round(4 + l * 22)}px` }} />
          ))}
        </span>
        <button
          type="button"
          className="send-btn"
          onClick={() => finish()}
          disabled={!ready || sending}
          aria-label="Send voice note"
        >
          {sending ? <span className="spinner" /> : <ArrowUp />}
        </button>
      </div>
    </div>
  )
}

// ---- playback ----------------------------------------------------------------

let nowPlaying = null // only one voice note plays at a time

export function VoicePlayer({ url, duration, seed = '' }) {
  const audio = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [rate, setRate] = useState(1)
  const [loading, setLoading] = useState(false)
  const total = Number.isFinite(duration) && duration > 0 ? duration : null

  // A stable, natural-looking waveform for this note.
  const bars = useRef(null)
  if (!bars.current) {
    let h = 2166136261
    for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    bars.current = Array.from({ length: 30 }, (_, i) => {
      h = Math.imul(h ^ (i + 1), 2246822507) >>> 0
      return 0.25 + ((h % 1000) / 1000) * 0.75
    })
  }

  useEffect(
    () => () => {
      audio.current?.pause()
      if (nowPlaying === audio.current) nowPlaying = null
    },
    [],
  )

  function ensureAudio() {
    if (audio.current) return audio.current
    const a = new Audio(url)
    a.preload = 'auto'
    a.onplaying = () => {
      setLoading(false)
      setPlaying(true)
    }
    a.onpause = () => setPlaying(false)
    a.onwaiting = () => setLoading(true)
    a.ontimeupdate = () => setPosition(a.currentTime)
    a.onended = () => {
      setPlaying(false)
      setPosition(0)
    }
    a.onerror = () => {
      setLoading(false)
      setPlaying(false)
    }
    audio.current = a
    return a
  }

  async function toggle(e) {
    e.stopPropagation()
    if (!url) return
    const a = ensureAudio()
    if (!a.paused) return a.pause()
    if (nowPlaying && nowPlaying !== a) nowPlaying.pause()
    nowPlaying = a
    a.playbackRate = rate
    setLoading(true)
    try {
      await a.play()
    } catch {
      setLoading(false)
    }
  }

  function cycleRate(e) {
    e.stopPropagation()
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1
    setRate(next)
    if (audio.current) audio.current.playbackRate = next
  }

  function seek(e) {
    e.stopPropagation()
    const a = ensureAudio()
    const length = Number.isFinite(a.duration) ? a.duration : total
    if (!length) return
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    try {
      a.currentTime = ratio * length
      setPosition(a.currentTime)
    } catch {
      // some recordings can't seek before they've loaded
    }
  }

  const progress = total ? Math.min(1, position / total) : 0
  return (
    <div className="voice-player">
      <button type="button" className="voice-play" onClick={toggle} aria-label={playing ? 'Pause voice note' : 'Play voice note'}>
        {loading && !playing ? <span className="spinner" /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <span className="voice-wave" onClick={seek} role="presentation">
        {bars.current.map((b, i) => (
          <span
            key={i}
            className={i / bars.current.length < progress ? 'played' : ''}
            style={{ height: `${Math.round(b * 24)}px` }}
          />
        ))}
      </span>
      <span className="voice-meta">
        <span className="voice-time">{formatDuration(playing || position ? position : total ?? 0)}</span>
        {(playing || rate !== 1) && (
          <button type="button" className="voice-rate" onClick={cycleRate} aria-label="Playback speed">
            {rate}×
          </button>
        )}
      </span>
    </div>
  )
}

// ---- icons -------------------------------------------------------------------

export const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
  </svg>
)
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" />
  </svg>
)
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const ArrowUp = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
