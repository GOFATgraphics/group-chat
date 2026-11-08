import { useState } from 'react'
import { supabase } from './supabase.js'
import { resolveLoginEmail } from './auth.js'

// Log in: email and password for an account that already exists.
// A legacy username still works too (no "@" in it): it maps to the
// member's internal @chat.local address, so the original members are
// not locked out by the move to public signup.
export default function Login({ onGoSignup }) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email: resolveLoginEmail(identifier),
      password,
    })
    if (error)
      setError(error.message === 'Invalid login credentials' ? 'Wrong email / username or password' : error.message)
    setBusy(false)
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <img className="login-logo" src="/logo.png" alt="" />
        <h1>Group Chat</h1>
        <p className="muted">Sign in with your email and password.</p>
        <p className="muted">Original members can still sign in with their username.</p>
        <label>
          Email or username
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
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
        <p className="muted">
          Don&apos;t have an account?{' '}
          <button type="button" className="link" onClick={onGoSignup}>
            Sign up
          </button>
        </p>
      </form>
    </div>
  )
}
