import { route, auth, check, present, HttpError, BUCKET } from '../lib.js'
import { transcribeAudio } from '../speech.js'

// GET    /api/messages/:id               -> one message
// GET    /api/messages/:id?transcribe=1  -> a voice note, plus "transcript" of what was said
// DELETE /api/messages/:id  -> delete one of your own messages
export default route({
  async GET(req) {
    const { sb } = await auth(req)
    const row = check(await sb.from('messages').select('*').eq('id', id(req)).single(), 'Message not found')
    const [message] = await present(sb, [row])
    if (req.query.transcribe && row.attachment_type?.startsWith('audio/')) {
      const { data: blob, error } = await sb.storage.from(BUCKET).download(row.attachment_path)
      if (error || !blob) throw new HttpError(404, 'Voice note audio not found')
      const { text, language } = await transcribeAudio(new Uint8Array(await blob.arrayBuffer()), row.attachment_type)
      message.transcript = text
      message.transcript_language = language
    }
    return { message }
  },

  async DELETE(req) {
    const { sb, userId } = await auth(req)
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
