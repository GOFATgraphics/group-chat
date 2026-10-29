import { useEffect, useMemo, useRef, useState } from 'react'
import { experimental_useRealtime as useRealtime } from '@ai-sdk/react'
import { gateway } from '@ai-sdk/gateway'
import { supabase } from './supabase.js'

// Full-screen live voice call with an AI member (loaded only when a call
// starts). The app asks /api/call/start for a ticket and the AI's settings,
// then the AI SDK realtime session streams audio between this browser and
// Vercel AI Gateway. On hang-up, onEnded gets the duration and transcript.

const WARN_BEFORE_END = 60 // seconds

export default function CallScreen({ peer, avatar, myName, onEnded }) {
  const [setup, setSetup] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await supabase.auth.getSession()
        const res = await fetch('/api/call/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
          body: JSON.stringify({ peer: peer.username }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
        if (!cancelled) setSetup(body)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [peer.username])

  if (error || !setup) {
    return (
      <CallFrame peer={peer} avatar={avatar} status={error ? 'Call failed' : `Calling ${peer.username}…`} error={error}>
        <div className="call-controls">
          <button className="call-btn end" onClick={() => onEnded({ duration: 0, transcript: '' })} aria-label="Cancel call">
            <HangUpIcon />
          </button>
        </div>
      </CallFrame>
    )
  }
  return <LiveCall setup={setup} peer={peer} avatar={avatar} myName={myName} onEnded={onEnded} />
}

function LiveCall({ setup, peer, avatar, myName, onEnded }) {
  const model = useMemo(() => gateway.experimental_realtime(setup.model), [setup.model])
  const [elapsed, setElapsed] = useState(0)
  const [muted, setMuted] = useState(false)
  const [problem, setProblem] = useState('')
  const stream = useRef(null)
  const startedAt = useRef(null)
  const warned = useRef(false)
  const ended = useRef(false)

  const call = useRealtime({
    model,
    api: { token: `/api/call/token?ticket=${encodeURIComponent(setup.ticket)}` },
    sessionConfig: setup.sessionConfig,
    onError: (err) => reportProblem(err),
  })
  // The SDK only reports "Failed to fetch realtime setup: <status>"; ask our
  // server for the actual reason so the screen says something useful.
  async function reportProblem(err) {
    const message = err?.message ?? String(err)
    if (!/realtime setup/i.test(message)) return setProblem(message)
    try {
      const res = await fetch(`/api/call/token?ticket=${encodeURIComponent(setup.ticket)}`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      setProblem(body.error || message)
    } catch {
      setProblem(message)
    }
  }

  // Timers and hang-up read the latest session (messages, methods) from here.
  const callRef = useRef(call)
  callRef.current = call

  // Disconnect exactly once. The SDK throws if it's asked after the hook has
  // unmounted (e.g. cleanup after hang-up), which must never crash the chat.
  const disconnected = useRef(false)
  const safeDisconnect = () => {
    if (disconnected.current) return
    disconnected.current = true
    try {
      callRef.current.disconnect()
    } catch {
      // already gone
    }
  }

  // Microphone + connect once.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        if (cancelled) return mic.getTracks().forEach((t) => t.stop())
        stream.current = mic
        await callRef.current.connect({ stream: mic })
        callRef.current.startAudioCapture(mic)
      } catch (err) {
        setProblem(
          err?.name === 'NotAllowedError'
            ? 'Microphone access is blocked. Allow it in your browser or phone settings to call.'
            : err.message || 'Could not start the call',
        )
      }
    })()
    return () => {
      cancelled = true
      stream.current?.getTracks().forEach((t) => t.stop())
      safeDisconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Once connected: the AI greets first, and the call timer starts.
  useEffect(() => {
    if (call.status !== 'connected' || startedAt.current) return
    startedAt.current = Date.now()
    call.requestResponse()
  }, [call.status, call])

  useEffect(() => {
    const t = setInterval(() => {
      if (!startedAt.current) return
      const secs = (Date.now() - startedAt.current) / 1000
      setElapsed(secs)
      if (!warned.current && secs >= setup.maxSeconds - WARN_BEFORE_END) {
        warned.current = true
        try {
          callRef.current.sendTextMessage('[Only one minute is left on this call. Start wrapping up and say goodbye soon.]')
        } catch {
          // session already closing
        }
      }
      if (secs >= setup.maxSeconds) hangUp()
    }, 500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.maxSeconds])

  function toggleMute() {
    const next = !muted
    stream.current?.getAudioTracks().forEach((t) => (t.enabled = !next))
    setMuted(next)
  }

  function hangUp() {
    if (ended.current) return
    ended.current = true
    const duration = startedAt.current ? Math.round((Date.now() - startedAt.current) / 1000) : 0
    const transcript = callRef.current.messages
      .map((m) => {
        const text = (m.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ')
          .trim()
        if (!text || text.startsWith('[')) return null // skip our own system notes
        return `${m.role === 'assistant' ? peer.username : myName}: ${text}`
      })
      .filter(Boolean)
      .join('\n')
    stream.current?.getTracks().forEach((t) => t.stop())
    safeDisconnect()
    onEnded({ duration, transcript })
  }

  const lastAiLine = useMemo(() => {
    for (let i = call.messages.length - 1; i >= 0; i--) {
      const m = call.messages[i]
      if (m.role !== 'assistant') continue
      const text = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim()
      if (text) return text
    }
    return ''
  }, [call.messages])

  const remaining = setup.maxSeconds - elapsed
  const status =
    problem
      ? 'Call problem'
      : call.status === 'connected'
        ? remaining <= WARN_BEFORE_END
          ? `${formatClock(elapsed)} · 1 minute left`
          : formatClock(elapsed)
        : call.status === 'error'
          ? 'Call failed'
          : `Calling ${peer.username}…`

  return (
    <CallFrame peer={peer} avatar={avatar} status={status} error={problem} speaking={call.isPlaying} caption={lastAiLine}>
      {call.status === 'connected' && !call.isPlaying && elapsed > 6 && !lastAiLine && (
        <button className="call-sound-hint" onClick={() => call.resumePlayback()}>
          Can't hear anything? Tap here
        </button>
      )}
      <div className="call-controls">
        <button
          className={`call-btn ${muted ? 'on' : ''}`}
          onClick={toggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          disabled={call.status !== 'connected'}
        >
          <MicIcon off={muted} />
          <span>{muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button className="call-btn end" onClick={hangUp} aria-label="End call">
          <HangUpIcon />
        </button>
      </div>
    </CallFrame>
  )
}

function CallFrame({ peer, avatar, status, error, speaking, caption, children }) {
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
        {caption && !error && <div className="call-caption">{caption}</div>}
      </div>
      {children}
    </div>
  )
}

const formatClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const HangUpIcon = () => (
  <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
    <path
      d="M3.5 14.2c4.7-4.3 12.3-4.3 17 0l-2.1 2.6c-.4.5-1.1.6-1.6.3l-2.3-1.4c-.4-.3-.6-.8-.5-1.3l.3-1.4a11 11 0 0 0-4.6 0l.3 1.4c.1.5-.1 1-.5 1.3l-2.3 1.4c-.5.3-1.2.2-1.6-.3z"
      fill="currentColor"
    />
  </svg>
)
const MicIcon = ({ off }) => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
  </svg>
)
