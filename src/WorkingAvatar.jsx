// The agent working illustration: the agent at a laptop, wearing
// headphones. Pure inline SVG + CSS animation — no image, no media
// download, and it works for every agent (the illustration is
// agent-neutral; the name and avatar already on screen say who it is).
// Colours come from CSS variables so it follows light and dark mode;
// `prefers-reduced-motion` freezes the animation (see styles.css).

// Header version: the 64 px circle that replaces the peer's avatar while
// the agent works. When the work finishes, the app renders the avatar
// again — this component never shows on its own outside a working state.
export function WorkingAvatar({ label }) {
  return (
    <span
      className="working-avatar"
      role="img"
      aria-label={label ? `Working: ${label}` : 'Working'}
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
// rendered inside the typing bubble in place of the three dots.
export function WorkingBubble({ label }) {
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
