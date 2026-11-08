import { useState } from 'react'
import { supabase } from './supabase.js'
import { validateSignup } from './auth.js'

// Sign up: email, password and confirm password only — no username field.
// The username is derived from the email by a database trigger
// (supabase/migrations/0022_public_signup.sql), so a signed-up user can
// never claim the admin or bot names. Email confirmation is OFF in
// Supabase Auth for v1, so signUp returns a session immediately; the
// "check your email" state below only applies if confirmation is ever
// turned ON.
export default function Signup({ onGoLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    const problem = validateSignup(email, password, confirm)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError('')
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
    })
    setBusy(false)
    if (error) {
      setError(
        /already registered|already exists/i.test(error.message)
          ? 'An account with this email already exists. Log in instead.'
          : error.message,
      )
      return
    }
    // With email confirmation OFF there is a session and App renders Chat.
    // With it ON there is no session yet: tell the user to check email.
    if (!data.session) setNeedsConfirmation(true)
  }

  if (needsConfirmation) {
    return (
      <div className="login-page">
        <div className="login-card">
          <img className="login-logo" src="/logo.png" alt="" />
          <h1>Check your email</h1>
          <p className="muted">
            We sent a confirmation link to {email.trim().toLowerCase()}. Click it to finish creating your account, then come
            back here to log in.
          </p>
          <button className="primary" onClick={onGoLogin}>
            Back to log in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <img className="login-logo" src="/logo.png" alt="" />
        <h1>Create account</h1>
        <p className="muted">Sign up with your email to join the group chat.</p>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
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
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
        <p className="muted">
          Already have an account?{' '}
          <button type="button" className="link" onClick={onGoLogin}>
            Log in
          </button>
        </p>
      </form>
    </div>
  )
}
