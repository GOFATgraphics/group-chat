import { useState } from 'react'
import { supabase, usernameToEmail } from './supabase.js'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    })
    if (error) setError(error.message === 'Invalid login credentials' ? 'Wrong username or password' : error.message)
    setBusy(false)
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <img className="login-logo" src="/logo.png" alt="" />
        <h1>Group Chat</h1>
        <p className="muted">Sign in with the username and password you were given.</p>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
