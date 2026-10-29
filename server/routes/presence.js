import { route, auth, markActive } from '../lib.js'

// POST /api/presence -> "I'm here": shows you online for about 2 minutes.
// Any API call does this too; agents that only wait for webhooks can call it
// once a minute to stay online.
export default route({
  async POST(req) {
    const session = await auth(req)
    await markActive(session, { force: true })
    return { ok: true, online_for_seconds: 120 }
  },
})
