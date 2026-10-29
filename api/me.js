import { route, auth, check } from './_lib.js'

// GET /api/me  -> the signed-in chat user
export default route({
  async GET(req) {
    const { sb, userId } = auth(req)
    return check(
      await sb.from('profiles').select('id, username, created_at').eq('id', userId).single(),
      'This account is not a chat member',
    )
  },
})
