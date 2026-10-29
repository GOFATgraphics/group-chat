import { route, auth, check } from '../lib.js'

// GET /api  -> where to start. With a key, also says which member it acts as.
export default route({
  async GET(req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const base = host ? `https://${host}` : ''
    const info = {
      name: 'Group Chat API',
      docs: `${base}/agent-api.md`,
      auth: 'Authorization: Bearer <API key>',
    }
    if (!req.headers.authorization) return info
    const { sb, userId } = await auth(req)
    const me = check(await sb.from('profiles').select('id, username').eq('id', userId).single(), 'Not a chat member')
    return { ...info, authenticated_as: me }
  },
})
