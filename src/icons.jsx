// App icons in one consistent style (SF Symbols-like: 24px grid, rounded
// 1.9px strokes, currentColor), plus a coloured iOS-Settings-style tile.
// Used everywhere the interface used to show emoji.

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }

const make = (paths) =>
  function Icon({ size = 20, style, className }) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={style} className={className}>
        {paths}
      </svg>
    )
  }

export const SearchIcon = make(
  <>
    <circle cx="10.5" cy="10.5" r="6.2" {...S} />
    <path d="M15.2 15.2 20 20" {...S} strokeWidth="2.2" />
  </>,
)
export const PinIcon = make(
  <>
    <path d="M9 3.5h6l-1 5.2 3.2 3.3v1.5H6.8V12L10 8.7z" {...S} />
    <path d="M12 13.5v7" {...S} />
  </>,
)
export const PollIcon = make(
  <>
    <rect x="3.5" y="5" width="11" height="3.6" rx="1.8" {...S} />
    <rect x="3.5" y="10.2" width="17" height="3.6" rx="1.8" {...S} />
    <rect x="3.5" y="15.4" width="7" height="3.6" rx="1.8" {...S} />
  </>,
)
export const ClockIcon = make(
  <>
    <circle cx="12" cy="12" r="8.3" {...S} />
    <path d="M12 7.5V12l3 2" {...S} />
  </>,
)
export const AlarmIcon = make(
  <>
    <circle cx="12" cy="13" r="7" {...S} />
    <path d="M12 9.5V13l2.4 1.6M5 4.5 3 6.5M19 4.5l2 2" {...S} />
  </>,
)
export const ChecklistIcon = make(
  <>
    <path d="m4 6.5 1.6 1.6L8.5 5M4 13l1.6 1.6L8.5 11.5" {...S} />
    <path d="M11.5 7h8.5M11.5 13.5h8.5M11.5 19h8.5M4.5 19h3" {...S} />
  </>,
)
export const NoteIcon = make(
  <>
    <path d="M6.5 3.5h7.5l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z" {...S} />
    <path d="M13.5 3.8V8.5h4.7M8.5 12.5h7M8.5 16h5" {...S} />
  </>,
)
export const DecisionIcon = make(
  <>
    <path d="m12 3 2.2 1.6 2.7-.2.8 2.6 2.2 1.6-1 2.5 1 2.5-2.2 1.6-.8 2.6-2.7-.2L12 19.2l-2.2-1.6-2.7.2-.8-2.6-2.2-1.6 1-2.5-1-2.5L6.3 7l.8-2.6 2.7.2z" {...S} />
    <path d="m8.8 11.3 2.2 2.2 4.3-4.3" {...S} />
  </>,
)
export const SummaryIcon = make(
  <>
    <path d="M4 6h16M4 10.5h16M4 15h10M4 19.5h7" {...S} />
  </>,
)
export const SparklesIcon = make(
  <>
    <path d="M11 3.5c.5 3.7 2.3 5.5 6 6-3.7.5-5.5 2.3-6 6-.5-3.7-2.3-5.5-6-6 3.7-.5 5.5-2.3 6-6z" {...S} />
    <path d="M18.5 14.5c.25 1.6 1 2.35 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.15 2.25-.9 2.5-2.5z" {...S} strokeWidth="1.6" />
  </>,
)
export const PeopleIcon = make(
  <>
    <circle cx="9" cy="8.5" r="3.3" {...S} />
    <path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5" {...S} />
    <path d="M15.5 5.6a3.2 3.2 0 0 1 0 6M17.5 14.8c1.8.6 3 2.2 3.5 4.7" {...S} />
  </>,
)
export const XIcon = make(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...S} strokeWidth="2.1" />)
export const CameraIcon = make(
  <>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.3-2h5.2l1.3 2h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" {...S} />
    <circle cx="12" cy="12.5" r="3.5" {...S} />
  </>,
)
export const PhotoIcon = make(
  <>
    <rect x="3.5" y="5" width="17" height="14" rx="3" {...S} />
    <circle cx="9" cy="10" r="1.6" fill="currentColor" />
    <path d="m4 17 5-4.5 3.5 3 3-2.5L20 17" {...S} />
  </>,
)
export const VideoIcon = make(
  <>
    <rect x="3" y="6" width="13" height="12" rx="3" {...S} />
    <path d="m16 10.5 5-3v9l-5-3z" {...S} />
  </>,
)
export const WaveIcon = make(<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3" {...S} />)
export const ClipIcon = make(
  <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1" {...S} />,
)
export const PhoneIcon = make(
  <path d="M6.6 3.8 9 3.5l1.6 4-1.9 1.4a11 11 0 0 0 6.4 6.4l1.4-1.9 4 1.6-.3 2.4a2.2 2.2 0 0 1-2.3 1.9C10.4 18.9 5.1 13.6 4.7 6.1a2.2 2.2 0 0 1 1.9-2.3z" {...S} />,
)

// Coloured rounded-square tile with a white glyph (like iOS Settings).
export const TILE = {
  blue: 'linear-gradient(180deg, #3d9bff, #0a7aff)',
  yellow: 'linear-gradient(180deg, #ffd23f, #ffb800)',
  orange: 'linear-gradient(180deg, #ffa53d, #ff8a00)',
  red: 'linear-gradient(180deg, #ff6b62, #ff3b30)',
  green: 'linear-gradient(180deg, #4cd964, #2fb34a)',
  purple: 'linear-gradient(180deg, #a77bff, #7d4dff)',
  indigo: 'linear-gradient(180deg, #6e6bff, #4a46e8)',
  gray: 'linear-gradient(180deg, #a1a1a6, #7c7c80)',
}
export function IconTile({ icon: Icon, color = 'blue', size = 30 }) {
  return (
    <span className="icon-tile" style={{ width: size, height: size, background: TILE[color] }} aria-hidden="true">
      <Icon size={Math.round(size * 0.62)} />
    </span>
  )
}

// The "AI" label next to Adam and Ali.
export function AIBadge() {
  return (
    <span className="ai-badge" title="AI member">
      <SparklesIcon size={11} />
      AI
    </span>
  )
}

// What kind of message this is, for icons in previews.
export function messageKind(m) {
  if (!m) return null
  if (m.call_duration != null) return 'call'
  if (m.content?.startsWith('📊 ')) return 'poll'
  if (m.content?.startsWith('⏰ Reminder:')) return 'reminder'
  const t = m.attachment_type ?? ''
  if (!m.attachment_path) return null
  if (t.startsWith('image/')) return 'photo'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'voice'
  return 'file'
}
export const KIND_ICON = { call: PhoneIcon, poll: PollIcon, reminder: AlarmIcon, photo: PhotoIcon, video: VideoIcon, voice: WaveIcon, file: ClipIcon }

// ---- big round "app" icons for the + menu (iOS 26 style) ----------------
// Drawn with gradients so they read as real app icons, not line glyphs.

export function AppCamera({ size = 46 }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <radialGradient id="cam-bezel" cx="40%" cy="30%" r="75%">
          <stop offset="0" stopColor="#f4f4f6" />
          <stop offset="0.55" stopColor="#b9b9be" />
          <stop offset="1" stopColor="#6e6e73" />
        </radialGradient>
        <radialGradient id="cam-glass" cx="42%" cy="38%" r="65%">
          <stop offset="0" stopColor="#3b4a7a" />
          <stop offset="0.45" stopColor="#14182c" />
          <stop offset="1" stopColor="#020205" />
        </radialGradient>
        <radialGradient id="cam-shine" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#9fd0ff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#9fd0ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#cam-bezel)" />
      <circle cx="24" cy="24" r="17.5" fill="#1c1c1f" />
      <circle cx="24" cy="24" r="14.5" fill="url(#cam-glass)" />
      <circle cx="24" cy="24" r="8" fill="#0a0c18" stroke="#2c3560" strokeWidth="1.2" />
      <ellipse cx="19.5" cy="18.5" rx="5.5" ry="3.6" fill="url(#cam-shine)" transform="rotate(-30 19.5 18.5)" />
      <circle cx="28.5" cy="28.5" r="1.6" fill="#6fa8ff" opacity="0.6" />
    </svg>
  )
}

export function AppPhotos({ size = 46 }) {
  const petals = ['#ff9f0a', '#ffd60a', '#a4d93a', '#34c759', '#5ac8fa', '#2f7bff', '#7d5cff', '#ff375f']
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <circle cx="24" cy="24" r="23" fill="#fff" stroke="rgba(0,0,0,.08)" />
      {petals.map((c, i) => (
        <ellipse key={i} cx="24" cy="15.2" rx="5" ry="8.4" fill={c} opacity="0.86" transform={`rotate(${i * 45} 24 24)`} style={{ mixBlendMode: 'multiply' }} />
      ))}
    </svg>
  )
}

export function AppFiles({ size = 46 }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="files-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef2f8" />
        </linearGradient>
        <linearGradient id="files-folder" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4fb0ff" />
          <stop offset="1" stopColor="#1677ff" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#files-bg)" stroke="rgba(0,0,0,.08)" />
      <path d="M12 16.5a2 2 0 0 1 2-2h6.2l2.4 2.6H34a2 2 0 0 1 2 2V32a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2z" fill="url(#files-folder)" />
      <path d="M12 20.5h24" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.2" />
    </svg>
  )
}

export function AppAudio({ size = 46 }) {
  const bars = [6, 11, 17, 11, 7, 13, 6]
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="audio-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff7a5c" />
          <stop offset="1" stopColor="#ef3b2d" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#audio-bg)" />
      {bars.map((h, i) => (
        <rect key={i} x={13.6 + i * 3.3} y={24 - h / 2} width="2" height={h} rx="1" fill="#fff" />
      ))}
    </svg>
  )
}

export function AppPolls({ size = 46 }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="polls-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffcf4a" />
          <stop offset="1" stopColor="#f5a623" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#polls-bg)" />
      <rect x="13" y="15.5" width="17" height="4.2" rx="2.1" fill="#fff" />
      <rect x="13" y="21.9" width="22" height="4.2" rx="2.1" fill="#fff" />
      <rect x="13" y="28.3" width="11" height="4.2" rx="2.1" fill="#fff" />
    </svg>
  )
}

export function AppTask({ size = 46 }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="task-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7ed492" />
          <stop offset="1" stopColor="#34a853" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#task-bg)" />
      <path d="M15 24.5 21 30.5 33 17.5" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AppSendLater({ size = 46 }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <radialGradient id="later-bg" cx="45%" cy="35%" r="70%">
          <stop offset="0" stopColor="#8fd3ff" />
          <stop offset="1" stopColor="#3aa3f5" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="21.5" fill="none" stroke="#3aa3f5" strokeWidth="2.6" strokeDasharray="5.2 3.2" strokeLinecap="round" />
      <circle cx="24" cy="24" r="16" fill="url(#later-bg)" />
      <path d="M24 16v8.5l5.5 3.2" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
