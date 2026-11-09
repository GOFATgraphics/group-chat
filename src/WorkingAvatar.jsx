// The agent working illustration: the agent at a laptop, wearing
// headphones. Agents with their own animated picture (see WORKING_MEDIA
// below — Gauri first) show that video; everyone else gets the generic
// inline SVG illustration (no image, no media download, agent-neutral).
// Colours come from CSS variables so the SVG follows light and dark mode;
// `prefers-reduced-motion` freezes the SVG animation and shows the still
// image instead of the video (see styles.css).

import { useEffect, useState } from 'react'

// Per-agent working media: a real animated picture of the agent at a
// laptop with headphones, generated from the agent's reference pictures.
// Only Gauri has one so far; adam, ali and anurag keep the generic SVG
// until they get their own pictures. Adding an agent is one map entry
// plus the two files in public/.
export const WORKING_MEDIA = {
  gauri: { video: '/working-gauri.mp4', poster: '/working-gauri.jpg' },
}

// The media for a raw username (lowercased, trimmed), or null when the
// agent has no custom picture.
export function workingMediaFor(username) {
  const key = String(username ?? '').trim().toLowerCase()
  return WORKING_MEDIA[key] ?? null
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e) => setReduced(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

// The agent's own animated picture: the video while it plays, the still
// when it cannot — reduced motion, a failed video, or forceStill (the
// test stand-in for a failed video; there is no DOM here to fire the
// error event). If the still fails too (e.g. the media files have not
// landed yet), onMediaFailed tells the parent to fall back to the
// generic SVG — the indicator never shows a broken image. The wrapping
// span carries the accessible name; the media itself is decorative.
function WorkingVideo({ media, className, forceStill = false, onMediaFailed }) {
  const reducedMotion = usePrefersReducedMotion()
  const [videoFailed, setVideoFailed] = useState(false)
  const showStill = forceStill || reducedMotion || videoFailed
  if (showStill) {
    return <img className={className} src={media.poster} alt="" aria-hidden="true" onError={onMediaFailed} />
  }
  return (
    <video
      className={className}
      src={media.video}
      poster={media.poster}
      autoPlay
      muted
      loop
      playsInline
      onError={() => setVideoFailed(true)}
      aria-hidden="true"
    />
  )
}

function workingAriaLabel(label) {
  return label ? `Working: ${label}` : 'Working'
}

// Header version: the 64 px circle that replaces the peer's avatar while
// the agent works. When the work finishes, the app renders the avatar
// again — this component never shows on its own outside a working state.
export function WorkingAvatar({ label, username, forceStill = false }) {
  const media = workingMediaFor(username)
  const [mediaFailed, setMediaFailed] = useState(false)
  if (media && !mediaFailed) {
    return (
      <span className="working-avatar working-avatar-media" role="img" aria-label={workingAriaLabel(label)}>
        <WorkingVideo media={media} className="working-video" forceStill={forceStill} onMediaFailed={() => setMediaFailed(true)} />
      </span>
    )
  }
  return (
    <span
      className="working-avatar"
      role="img"
      aria-label={workingAriaLabel(label)}
    >
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g className="working-headphones" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M17 37 V29 a15 15 0 0 1 30 0 V37" />
          <rect x="12" y="35" width="9" height="14" rx="4.5" />
          <rect x="43" y="35" width="9" height="14" rx="4.5" />
        </g>
        <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="21" y="34" width="22" height="15" rx="2" />
          <path d="M15 53 h34 l3.5 3.5 h-41 z" />
        </g>
        <g fill="currentColor">
          <circle className="working-dot" cx="28" cy="41.5" r="1.8" />
          <circle className="working-dot" cx="33.5" cy="41.5" r="1.8" />
          <circle className="working-dot" cx="39" cy="41.5" r="1.8" />
        </g>
      </svg>
    </span>
  )
}

// Message-list version: a small laptop with the status label next to it,
// rendered inside the typing bubble in place of the three dots. Agents
// with their own picture get a small circular clip of it instead.
export function WorkingBubble({ label, username, forceStill = false }) {
  const media = workingMediaFor(username)
  const [mediaFailed, setMediaFailed] = useState(false)
  if (media && !mediaFailed) {
    return (
      <span className="working-bubble-inner">
        <WorkingVideo media={media} className="working-bubble-video" forceStill={forceStill} onMediaFailed={() => setMediaFailed(true)} />
        <span className="working-label">{label || 'working…'}</span>
      </span>
    )
  }
  return (
    <span className="working-bubble-inner">
      <svg className="working-mini" viewBox="0 0 24 24" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="5" width="14" height="10" rx="1.5" />
          <path d="M2.5 18.5 h19" />
        </g>
        <g fill="currentColor">
          <circle className="working-dot" cx="9" cy="10" r="1.3" />
          <circle className="working-dot" cx="12" cy="10" r="1.3" />
          <circle className="working-dot" cx="15" cy="10" r="1.3" />
        </g>
      </svg>
      <span className="working-label">{label || 'working…'}</span>
    </span>
  )
}
