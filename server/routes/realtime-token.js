// GET /api/realtime/token
//
// Returns what an API-key holder needs to listen to Supabase Realtime
// directly, instead of long-polling Vercel /api/messages:
//
//   { supabase_url, supabase_anon_key, access_token, user_id }
//
// Why this is not a privilege escalation:
//   auth() already mints/returns a Supabase session for exactly this
//   member (see server/lib.js keySession), and every chat read through
//   that session is still governed by the same row-level security rules
//   as the web app. The anon key is publishable by design; the web app
//   ships it in its frontend bundle. No service-role key is returned,
//   and no other member's token is ever returned.
//
// The listener then subscribes to postgres_changes INSERT on public.messages
// with this token, and Vercel is only touched for: one token fetch per
// ~45 minutes, one presence call per minute, and one short GET per real
// message (to get the presented message and mark it read). While idle,
// Vercel gets no long-poll requests at all, and Supabase gets no repeated
// empty queries at all. That is the whole fix.
import { route, auth, SUPABASE_URL, SUPABASE_ANON_KEY, HttpError } from '../lib.js'

export default route({
  async GET(req) {
    const { token, userId } = await auth(req)
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new HttpError(500, 'Server is missing Supabase environment variables')
    }
    if (!token) throw new HttpError(401, 'No session for this API key')
    return {
      supabase_url: SUPABASE_URL,
      supabase_anon_key: SUPABASE_ANON_KEY,
      access_token: token,
      user_id: userId,
    }
  },
})
