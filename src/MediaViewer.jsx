import { useEffect, useRef, useState } from 'react'
import { canShareFiles, saveMedia, shareMedia } from './media.js'

// Full-screen photo/video viewer, like iMessage/Photos:
// - opens on just the picture (black); one tap shows the bars (light, with
//   ✕, who sent it and when, zoom, reply, share), another tap hides them
// - swipe the picture down to go back to the chat (it shrinks and follows
//   your finger, the background fades)
// - pinch or double-tap to zoom, drag to move around when zoomed, mouse
//   wheel / + − on desktop
// item: { url, name, type: 'image' | 'video', sender?, date?, msg? }

const MAX_ZOOM = 5
const DISMISS_AT = 110 // px of downward drag that closes the viewer
const TAP_WAIT = 260 // ms: a second tap within this is a double tap

export default function MediaViewer({ item, onClose, onReply }) {
  const isImage = item.type !== 'video'
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [chrome, setChrome] = useState(!isImage) // videos keep their controls visible
  const [drag, setDrag] = useState(0) // swipe-down offset
  const [closing, setClosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const tapTimer = useRef(null)
  const stage = useRef(null)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') close()
      if (e.key === '+' || e.key === '=') zoomBy(1.5)
      if (e.key === '-') zoomBy(1 / 1.5)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(tapTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function close() {
    setClosing(true)
    setTimeout(onClose, 200)
  }

  const clampScale = (s) => Math.min(MAX_ZOOM, Math.max(1, s))
  const settle = (v) => (v.scale <= 1.01 ? { scale: 1, x: 0, y: 0 } : v)

  function zoomBy(factor, cx = 0, cy = 0) {
    setView((v) => {
      const scale = clampScale(v.scale * factor)
      const k = scale / v.scale
      return settle({ scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k })
    })
  }

  function fromCenter(e) {
    const r = stage.current.getBoundingClientRect()
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]
  }

  function onPointerDown(e) {
    if (!isImage) return
    try {
      stage.current.setPointerCapture?.(e.pointerId)
    } catch {
      // not a real pointer (e.g. synthetic); capture is only a nicety
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    if (pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      gesture.current = { type: 'pinch', dist, start: view }
      setDrag(0)
    } else if (pts.length === 1) {
      gesture.current = { type: 'pan', from: { x: e.clientX, y: e.clientY }, start: view, moved: false, dismiss: null, at: Date.now() }
    }
  }

  function onPointerMove(e) {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    const pts = [...pointers.current.values()]
    if (g.type === 'pinch' && pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const scale = clampScale(g.start.scale * (dist / g.dist))
      const k = scale / g.start.scale
      setView({ scale, x: g.start.x * k, y: g.start.y * k })
    } else if (g.type === 'pan') {
      const dx = e.clientX - g.from.x
      const dy = e.clientY - g.from.y
      if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true
      if (g.start.scale > 1) return setView({ ...g.start, x: g.start.x + dx, y: g.start.y + dy })
      // not zoomed: a mostly vertical drag pulls the picture away
      if (g.dismiss == null && g.moved) g.dismiss = Math.abs(dy) > Math.abs(dx)
      if (g.dismiss) setDrag(dy)
    }
  }

  function onPointerUp(e) {
    const g = gesture.current
    pointers.current.delete(e.pointerId)
    gesture.current = null
    if (g?.type === 'pinch') return setView(settle)
    if (g?.type !== 'pan') return
    if (g.dismiss) {
      const fast = Math.abs(drag) / Math.max(1, Date.now() - g.at) > 0.6
      if (Math.abs(drag) > DISMISS_AT || (fast && Math.abs(drag) > 40)) return close()
      return setDrag(0)
    }
    if (g.moved) return
    // A tap: wait to see if it's a double tap (zoom); otherwise show/hide the bars.
    if (tapTimer.current) {
      clearTimeout(tapTimer.current)
      tapTimer.current = null
      const [cx, cy] = fromCenter(e)
      setView((v) => (v.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: -cx * 1.5, y: -cy * 1.5 }))
      return
    }
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null
      setChrome((c) => !c)
    }, TAP_WAIT)
  }

  function onWheel(e) {
    if (!isImage) return
    const [cx, cy] = fromCenter(e)
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy)
  }

  async function run(action) {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const pull = Math.min(1, Math.abs(drag) / 400)
  const imgTransform = drag
    ? `translate(${view.x}px, ${view.y + drag}px) scale(${view.scale * (1 - 0.25 * pull)})`
    : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  const share = canShareFiles()

  return (
    <div
      className={`viewer ${chrome ? 'chrome' : ''} ${closing ? 'closing' : ''}`}
      style={{ '--pull': pull }}
      role="dialog"
      aria-modal="true"
      aria-label={isImage ? 'Photo' : 'Video'}
    >
      <div className="viewer-bg" style={{ opacity: closing ? 0 : 1 - pull }} />

      <div className="viewer-top" aria-hidden={!chrome}>
        <button className="viewer-round" onClick={close} aria-label="Close" tabIndex={chrome ? 0 : -1}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="viewer-title">
          <b>{item.sender ?? (isImage ? 'Photo' : 'Video')}</b>
          {item.date && <span>{item.date}</span>}
        </div>
        <span className="viewer-spacer" />
      </div>

      <div
        className="viewer-stage"
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {isImage ? (
          <img
            src={item.url}
            alt={item.name}
            draggable={false}
            style={{ transform: closing ? `translateY(${drag >= 0 ? 60 : -60}vh) scale(0.6)` : imgTransform }}
            className={gesture.current && !closing ? '' : 'animate'}
          />
        ) : (
          <video src={item.url} controls autoPlay playsInline />
        )}
      </div>

      <div className="viewer-bottom" aria-hidden={!chrome}>
        <div className="viewer-pill">
          {isImage && (
            <button
              onClick={() => setView((v) => (v.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 }))}
              aria-label={view.scale > 1 ? 'Zoom out' : 'Zoom in'}
              tabIndex={chrome ? 0 : -1}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M15.5 15.5 20 20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                <path d={view.scale > 1 ? 'M7.5 10.5h6' : 'M7.5 10.5h6M10.5 7.5v6'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {onReply && (
            <button
              onClick={() => {
                onClose()
                onReply()
              }}
              aria-label="Reply"
              tabIndex={chrome ? 0 : -1}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                <path d="M10 5 4 11l6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4.5 11H13a7 7 0 0 1 7 7v1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <button
          className="viewer-round"
          disabled={busy}
          tabIndex={chrome ? 0 : -1}
          aria-label={share ? 'Share or save' : 'Save'}
          onClick={() =>
            run(() =>
              share ? shareMedia(item.url, item.name, isImage ? 'image' : 'video') : saveMedia(item.url, item.name, isImage ? 'image' : 'video'),
            )
          }
        >
          {share ? (
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
