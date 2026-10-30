import { route, auth, check, SUPABASE_URL } from '../lib.js'

// GET /api/members  -> everyone in the group chat, with their profile photo
export default route({
  async GET(req) {
    const { sb } = await auth(req)
    const rows = check(await sb.from('profiles').select('id, username, is_ai, avatar_path, created_at').order('username'))
    return rows.map(({ avatar_path, ...p }) => ({
      ...p,
      avatar_url: avatar_path ? `${SUPABASE_URL}/storage/v1/object/public/avatars/${avatar_path}` : null,
    }))
  },
})
