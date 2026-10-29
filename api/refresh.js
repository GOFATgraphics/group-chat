import { route, client, body, HttpError } from './_lib.js'
import { session } from './login.js'

// POST /api/refresh  { "refresh_token": "..." }  -> new access + refresh token
export default route({
  async POST(req) {
    const { refresh_token } = body(req)
    if (!refresh_token) throw new HttpError(400, 'refresh_token is required')
    const { data, error } = await client().auth.refreshSession({ refresh_token })
    if (error || !data.session) throw new HttpError(401, 'Refresh token is invalid or already used. Log in again.')
    return session(data.session)
  },
})
