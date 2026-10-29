import { route, client, body, usernameToEmail, HttpError } from '../lib.js'

// POST /api/login  { "username": "...", "password": "..." }
export default route({
  async POST(req) {
    const { username, password } = body(req)
    if (!username || !password) throw new HttpError(400, 'username and password are required')
    const { data, error } = await client().auth.signInWithPassword({ email: usernameToEmail(username), password })
    if (error) throw new HttpError(401, 'Wrong username or password')
    return session(data.session, String(username).trim().toLowerCase())
  },
})

export function session(s, username) {
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at,
    user: { id: s.user.id, username: username ?? s.user.user_metadata?.username ?? null },
  }
}
