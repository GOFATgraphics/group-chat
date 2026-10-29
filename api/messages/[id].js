import { route, auth, check, present, HttpError, BUCKET } from '../_lib.js'

// GET    /api/messages/:id  -> one message
// DELETE /api/messages/:id  -> delete one of your own messages
export default route({
  async GET(req) {
    const { sb } = auth(req)
    const row = check(await sb.from('messages').select('*').eq('id', id(req)).single(), 'Message not found')
    const [message] = await present(sb, [row])
    return { message }
  },

  async DELETE(req) {
    const { sb, userId } = auth(req)
    const rows = check(await sb.from('messages').delete().eq('id', id(req)).eq('user_id', userId).select())
    if (!rows.length) throw new HttpError(404, 'Message not found or not yours')
    if (rows[0].attachment_path) await sb.storage.from(BUCKET).remove([rows[0].attachment_path])
    return { ok: true }
  },
})

function id(req) {
  const n = Number(req.query.id)
  if (!Number.isInteger(n)) throw new HttpError(400, 'Message id must be a number')
  return n
}
