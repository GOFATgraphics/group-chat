import { usernameToEmail } from './supabase.js'

// Log in accepts a real email, or a legacy username (no "@" in it).
// The 8 existing members were created by create_chat_user and sign in
// with a username today; forcing them onto a real email they never had
// would lock them out. New users sign up — and therefore log in — with
// their real email.
export const resolveLoginEmail = (input) => {
  const value = input.trim()
  return value.includes('@') ? value.toLowerCase() : usernameToEmail(value)
}

// Client-side signup validation, shown inline before any Supabase call.
// Supabase Auth's own format and password rules are the floor; this is
// the friendlier first check, not a replacement for them.
export const validateSignup = (email, password, confirm) => {
  const clean = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return 'Enter a valid email address.'
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (password !== confirm) return "Passwords don't match."
  return null
}
