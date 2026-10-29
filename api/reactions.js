import { route, auth, body, check, HttpError } from './_lib.js'

// POST   /api/reactions  { "message_id": 123, "emoji": "❤️" }  -> add a tapback
// DELETE /api/reactions  { "message_id": 123, "emoji": "❤️" }  -> remove it
export default route({
  async POST(req) {
    const { sb } = await auth(req)
    const { message_id, emoji } = args(req)
    const { error } = await sb.from('reactions').insert({ message_id, emoji })
    if (error && error.code !== '23505') check({ error }) // 23505: already reacted, fine
    return { ok: true }
  },

  async DELETE(req) {
    const { sb, userId } = await auth(req)
    const { message_id, emoji } = args(req)
    check(await sb.from('reactions').delete().match({ message_id, emoji, user_id: userId }))
    return { ok: true }
  },
})

function args(req) {
  const b = { ...req.query, ...body(req) }
  const message_id = Number(b.message_id)
  if (!Number.isInteger(message_id) || !b.emoji) throw new HttpError(400, 'message_id and emoji are required')
  return { message_id, emoji: String(b.emoji) }
}
