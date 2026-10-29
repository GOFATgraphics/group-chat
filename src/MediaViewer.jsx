import { useEffect, useRef, useState } from 'react'
import { canShareFiles, saveMedia, shareMedia } from './media.js'

// Full-screen photo/video viewer: pinch or double-tap to zoom, drag to move
// around when zoomed, mouse wheel on desktop, Save and Share buttons.
// item: { url, name, type: 'image' | 'video' }

const MAX_ZOOM = 5

export default function MediaViewer({ item, onClose }) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [busy, setBusy] = useState(false)
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const lastTap = useRef(0)
  const downTarget = useRef(null) // where the current press started
  const stage = useRef(null)
  const isImage = item.type !== 'video'

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '+' || e.key === '=') zoomBy(1.5)
      if (e.key === '-') zoomBy(1 / 1.5)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clampScale = (s) => Math.min(MAX_ZOOM, Math.max(1, s))
  const settle = (v) => (v.scale <= 1.01 ? { scale: 1, x: 0, y: 0 } : v)

  function zoomBy(factor, cx = 0, cy = 0) {
    setView((v) => {
      const scale = clampScale(v.scale * factor)
      const k = scale / v.scale
      // keep the point under (cx, cy) - relative to the stage centre - in place
      return settle({ scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k })
    })
  }

  function fromCenter(e) {
    const r = stage.current.getBoundingClientRect()
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]
  }

  function onPointerDown(e) {
    downTarget.current = e.target
    if (!isImage) return
    stage.current.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    if (pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      gesture.current = { type: 'pinch', dist, start: view }
    } else if (pts.length === 1) {
      gesture.current = { type: 'pan', from: { x: e.clientX, y: e.clientY }, start: view, moved: false }
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
      if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true
      if (g.start.scale > 1) setView({ ...g.start, x: g.start.x + dx, y: g.start.y + dy })
    }
  }

  function onPointerUp(e) {
    const g = gesture.current
    pointers.current.delete(e.pointerId)
    if (g?.type === 'pinch') {
      gesture.current = null
      setView(settle)
      return
    }
    if (g?.type === 'pan' && !g.moved && e.pointerType !== 'mouse') {
      // double tap on a touchscreen toggles zoom at that spot (mouse uses onDoubleClick)
      const now = Date.now()
      if (now - lastTap.current < 300) {
        toggleZoomAt(e)
        lastTap.current = 0
      } else {
        lastTap.current = now
      }
    }
    gesture.current = null
  }

  function toggleZoomAt(e) {
    const [cx, cy] = fromCenter(e)
    setView((v) => (v.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: -cx * 1.5, y: -cy * 1.5 }))
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

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={isImage ? 'Photo' : 'Video'}>
      <div className="viewer-bar">
        <button className="viewer-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <span className="viewer-name">{item.name}</span>
        {canShareFiles() && (
          <button className="viewer-btn" disabled={busy} onClick={() => run(() => shareMedia(item.url, item.name))}>
            Share
          </button>
        )}
        <button className="viewer-btn" disabled={busy} onClick={() => run(() => saveMedia(item.url, item.name))}>
          Save
        </button>
      </div>

      <div
        className="viewer-stage"
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={(e) => isImage && toggleZoomAt(e)}
        onClick={(e) => {
          // Close on a tap on the dark background only: a press that started
          // on the photo (e.g. the first click of a double-click) must not.
          if (e.target === e.currentTarget && downTarget.current === e.currentTarget && view.scale === 1) onClose()
        }}
      >
        {isImage ? (
          <img
            src={item.url}
            alt={item.name}
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            className={gesture.current ? '' : 'animate'}
          />
        ) : (
          <video src={item.url} controls autoPlay playsInline />
        )}
      </div>

      {isImage && (
        <div className="viewer-zoom">
          <button className="viewer-btn" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out" disabled={view.scale <= 1}>
            −
          </button>
          <button className="viewer-btn" onClick={() => setView({ scale: 1, x: 0, y: 0 })} aria-label="Fit to screen">
            {Math.round(view.scale * 100)}%
          </button>
          <button className="viewer-btn" onClick={() => zoomBy(1.5)} aria-label="Zoom in" disabled={view.scale >= MAX_ZOOM}>
            +
          </button>
        </div>
      )}
    </div>
  )
}
