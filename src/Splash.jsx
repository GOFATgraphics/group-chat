// Same loading screen as the static one in index.html (styles live there too),
// shown while the session and chat data load.
export default function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading">
      <img className="splash-logo" src="/logo-192.png" alt="" />
      <div className="splash-name">Group Chat</div>
      <div className="splash-typing">
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}
