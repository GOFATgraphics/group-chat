import { route, auth, body, check, present, sleep, HttpError, BUCKET, MAX_FILE_BYTES } from '../_lib.js'

const MAX_WAIT_SECONDS = 25
const POLL_MS = 300

// GET /api/messages
//   ?after_id=123      only messages newer than this id (oldest first)
//   ?before_id=123     page backwards through history
//   ?limit=50          1-200, default 50
//   ?wait=25           with after_id: hold the request open up to N seconds
//                      until a new message arrives (long-polling)
//   ?from_others=1     ignore your own messages (useful with wait)
//
// POST /api/messages
//   { "text": "hi" }
//   { "text": "optional caption", "file": { "name": "a.png", "type": "image/png", "base64": "..." } }
//   { "text": "optional caption", "file_url": "https://...", "file_name": "report.pdf" }
export default route({
  async GET(req) {
    const { sb, userId } = auth(req)
    const q = req.query
    const limit = clamp(Number(q.limit) || 50, 1, 200)
    const fromOthers = q.from_others === '1' || q.from_others === 'true'
    const wait = clamp(Number(q.wait) || 0, 0, MAX_WAIT_SECONDS)

    if (q.after_id != null) {
      const afterId = Number(q.after_id)
      const deadline = Date.now() + wait * 1000
      for (;;) {
        let query = sb.from('messages').select('*').gt('id', afterId).order('id').limit(limit)
        if (fromOthers) query = query.neq('user_id', userId)
        const rows = check(await query)
        if (rows.length || Date.now() >= deadline) return { messages: await present(sb, rows) }
        await sleep(POLL_MS)
      }
    }

    let query = sb.from('messages').select('*').order('id', { ascending: false }).limit(limit)
    if (q.before_id != null) query = query.lt('id', Number(q.before_id))
    if (fromOthers) query = query.neq('user_id', userId)
    const rows = check(await query).reverse()
    return { messages: await present(sb, rows) }
  },

  async POST(req) {
    const { sb, userId } = auth(req)
    const b = body(req)
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    const file = await readFile(b)
    if (!text && !file) throw new HttpError(400, 'Send "text", "file" or "file_url"')

    let attachment = {}
    if (file) {
      const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file'
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
      const { error } = await sb.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.type })
      if (error) throw new HttpError(400, `Upload failed: ${error.message}`)
      attachment = {
        attachment_path: path,
        attachment_name: file.name,
        attachment_type: file.type,
        attachment_size: file.bytes.length,
      }
    }

    const { data, error } = await sb
      .from('messages')
      .insert({ content: text || null, ...attachment })
      .select()
      .single()
    if (error) {
      if (attachment.attachment_path) await sb.storage.from(BUCKET).remove([attachment.attachment_path])
      check({ error })
    }
    const [message] = await present(sb, [data])
    return { message }
  },
})

async function readFile(b) {
  if (b.file?.base64) {
    const bytes = Buffer.from(b.file.base64, 'base64')
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'Files must be 25 MB or smaller')
    return { bytes, name: b.file.name || 'file', type: b.file.type || 'application/octet-stream' }
  }
  if (b.file_url) {
    let url
    try {
      url = new URL(b.file_url)
    } catch {
      throw new HttpError(400, 'file_url is not a valid URL')
    }
    if (url.protocol !== 'https:') throw new HttpError(400, 'file_url must be https')
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new HttpError(400, `Could not download file_url (HTTP ${res.status})`)
    if (Number(res.headers.get('content-length')) > MAX_FILE_BYTES) throw new HttpError(413, 'Files must be 25 MB or smaller')
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'Files must be 25 MB or smaller')
    const name = b.file_name || decodeURIComponent(url.pathname.split('/').pop() || '') || 'file'
    const type = b.file_type || res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
    return { bytes, name, type }
  }
  return null
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
