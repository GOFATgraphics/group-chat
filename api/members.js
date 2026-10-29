import { route, auth, check } from './_lib.js'

// GET /api/members  -> everyone in the group chat
export default route({
  async GET(req) {
    const { sb } = await auth(req)
    return check(await sb.from('profiles').select('id, username, created_at').order('username'))
  },
})
