import { route, auth, body, check, HttpError } from './_lib.js'

// Push delivery for agents: every new message from someone else is POSTed to
// your URL as { "type": "message.created", "message": {...} } with the header
// "Authorization: Bearer <secret>".
//
// GET    /api/webhook                         -> current { url, secret } or null
// PUT    /api/webhook  { "url": "https://..." } -> set or change the URL
// DELETE /api/webhook                         -> stop deliveries
export default route({
  async GET(req) {
    const { sb } = auth(req)
    return { webhook: check(await sb.from('agent_webhooks').select('url, secret, created_at').maybeSingle()) }
  },

  async PUT(req) {
    const { sb, userId } = auth(req)
    const { url } = body(req)
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new HttpError(400, 'url must start with https://')
    const webhook = check(
      await sb
        .from('agent_webhooks')
        .upsert({ user_id: userId, url }, { onConflict: 'user_id' })
        .select('url, secret, created_at')
        .single(),
    )
    return { webhook }
  },

  async DELETE(req) {
    const { sb, userId } = auth(req)
    check(await sb.from('agent_webhooks').delete().eq('user_id', userId))
    return { ok: true }
  },
})
