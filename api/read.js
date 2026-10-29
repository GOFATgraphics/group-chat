import { route, auth, body, check, markRead, HttpError } from './_lib.js'

// POST /api/read  { "message_ids": [412, 413] }
// Marks messages as read so senders see blue ticks. GET /api/messages does
// this automatically; webhook-driven agents call this after handling a message.
export default route({
  async POST(req) {
    const { sb, userId } = auth(req)
    const ids = (body(req).message_ids || []).map(Number).filter(Number.isInteger)
    if (!ids.length) throw new HttpError(400, 'message_ids must be a non-empty array of ids')
    const rows = check(await sb.from('messages').select('id, user_id, recipient_id').in('id', ids.slice(0, 500)))
    await markRead(sb, userId, rows)
    return { ok: true, marked: rows.filter((m) => m.user_id !== userId).length }
  },
})
