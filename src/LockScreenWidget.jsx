import { useState } from 'react'

// Lock screen widget (Settings sheet). The script lives at
// /lock-screen-widget.js; the user pastes their API key into it and
// adds it in the Scriptable app. Short lines only — no explanation
// paragraphs (see the lock-screen-widget SPEC).
export default function LockScreenWidget() {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  async function copyScript() {
    setError('')
    try {
      const res = await fetch('/lock-screen-widget.js')
      if (!res.ok) throw new Error('Could not load the script')
      const text = await res.text()
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Copy failed; open /lock-screen-widget.js and copy it by hand.')
    }
  }

  return (
    <div className="lock-widget">
      <div className="lock-widget-head">Lock screen widget</div>
      <div className="lock-widget-card">
        <p className="lock-widget-line">See new messages and credits left on your iPhone lock screen.</p>
        <button className="lock-widget-copy" onClick={copyScript}>
          {copied ? 'Copied ✓' : 'Copy widget script'}
        </button>
        <ol className="lock-widget-steps">
          <li>Create an API key in API keys below, or use an existing one.</li>
          <li>Paste it into the script where it says PASTE_YOUR_KEY_HERE.</li>
          <li>In the Scriptable app add the script, then add the Scriptable widget to your lock screen.</li>
        </ol>
      </div>
      {error && <p className="setting-note error">{error}</p>}
    </div>
  )
}
