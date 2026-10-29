import { route, auth, body, broadcastTyping, userIdFor } from './_lib.js'

// POST /api/typing  { }                     -> "typing…" in the group chat
// POST /api/typing  { "to": "mom" }         -> "typing…" in your private chat with mom
// POST /api/typing  { "typing": false }     -> hide it again
// The bubble shows for about 6 seconds; call again every few seconds while you
// are still working on a reply. Sending the message also hides it.
export default route({
  async POST(req) {
    const { sb, userId, token } = await auth(req)
    const b = body(req)
    const to = b.to ? await userIdFor(sb, b.to) : null
    await broadcastTyping(token, userId, to, b.typing !== false)
    return { ok: true }
  },
})
