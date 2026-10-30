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
    // Collect every attachment path before the row is deleted, so the
    // extra pictures (0018) are removed from storage too, not just the
    // legacy first picture. Best-effort: a missing table (migration not
    // run yet) must not block deleting the message itself.
    let extraPaths = []
    try {
      const { data } = await sb.from('message_attachments').select('attachment_path').eq('message_id', id(req))
      extraPaths = (data ?? []).map((r) => r.attachment_path).filter(Boolean)
    } catch {
      extraPaths = []
    }
    const rows = check(await sb.from('messages').delete().eq('id', id(req)).eq('user_id', userId).select())
    if (!rows.length) throw new HttpError(404, 'Message not found or not yours')
    const paths = [...new Set([rows[0].attachment_path, ...extraPaths].filter(Boolean))]
    if (paths.length) await sb.storage.from(BUCKET).remove(paths)
    return { ok: true }
  },
})

function id(req) {
  const n = Number(req.query.id)
  if (!Number.isInteger(n)) throw new HttpError(400, 'Message id must be a number')
  return n
}
