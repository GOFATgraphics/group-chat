import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

// Personal API keys for AI agents (People sheet). A key is generated in the
// browser and shown once; only its SHA-256 hash is stored.
export default function ApiKeys({ username }) {
  const [keys, setKeys] = useState([])
  const [name, setName] = useState(`${username}'s AI`)
  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  async function load() {
    const { data, error: err } = await supabase
      .from('api_keys')
      .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
      .order('created_at', { ascending: false })
    if (err) setError(err.message)
    else setKeys(data)
  }

  useEffect(() => {
    load()
  }, [])

  async function create() {
    setBusy(true)
    setError('')
    const key = newKey()
    const { error: err } = await supabase.from('api_keys').insert({
      name: name.trim() || 'AI agent',
      key_prefix: key.slice(0, 12),
      key_hash: await sha256Hex(key),
    })
    setBusy(false)
    if (err) return setError(err.message)
    setCreated(key)
    load()
  }

  async function revoke(k) {
    if (!window.confirm(`Revoke "${k.name}"? Any AI using it loses access immediately.`)) return
    const { error: err } = await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', k.id)
    if (err) setError(err.message)
    load()
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      setError('Copy failed; select the text and copy it by hand.')
    }
  }

  const origin = window.location.origin
  const instructions = created
    ? `You can now take part in our Group Chat as the member "${username}".\n` +
      `API: ${origin}/api\n` +
      `API key: ${created}\n` +
      `Send the key on every request as the header: Authorization: Bearer ${created}\n` +
      `Instructions: ${origin}/agent-api.md\n\n` +
      `Read the instructions, check the key with GET ${origin}/api, then set yourself up to ` +
      `hear new messages instantly (webhook or long-polling) and reply to them. ` +
      `Keep the key secret.`
    : ''

  return (
    <div className="api-keys">
      <div className="api-keys-head">API keys</div>
      <p className="setting-note muted">
        Give an AI agent a key and it can read and reply in this chat as <b>{username}</b>, including your private
        messages. Revoke a key to cut it off.
      </p>

      {created ? (
        <div className="api-key-created">
          <div className="api-key-warning">Copy this key now. It won&apos;t be shown again.</div>
          <code className="api-key-value">{created}</code>
          <div className="api-key-actions">
            <button onClick={() => copy(created, 'key')}>{copied === 'key' ? 'Copied ✓' : 'Copy key'}</button>
            <button onClick={() => copy(instructions, 'msg')}>
              {copied === 'msg' ? 'Copied ✓' : 'Copy message for your AI'}
            </button>
          </div>
          <textarea className="api-key-instructions" readOnly value={instructions} rows={7} />
          <button className="api-key-done" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      ) : (
        <div className="api-key-create">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Key name" />
          <button onClick={create} disabled={busy}>
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="member-list api-key-list">
          {keys.map((k) => (
            <li key={k.id} className={k.revoked_at ? 'revoked' : ''}>
              <span className="api-key-meta">
                <span className="api-key-name">{k.name}</span>
                <span className="muted">
                  {k.key_prefix}… ·{' '}
                  {k.revoked_at
                    ? 'revoked'
                    : k.last_used_at
                      ? `last used ${new Date(k.last_used_at).toLocaleString()}`
                      : 'never used'}
                </span>
              </span>
              {!k.revoked_at && (
                <button className="api-key-revoke" onClick={() => revoke(k)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="setting-note error">{error}</p>}
    </div>
  )
}

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes))
  return 'gck_' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
