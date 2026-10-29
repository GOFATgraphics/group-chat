import {
  route, auth, body, check, present, markRead, userIdFor, sleep, HttpError, BUCKET, MAX_FILE_BYTES,
} from '../lib.js'
import { speak, voiceFor } from '../speech.js'

const MAX_WAIT_SECONDS = 25
const POLL_MS = 150

// GET /api/messages
//   Which conversation (default: the group chat plus your own direct messages):
//   ?conversation=group   group chat only
//   ?with=<username>      only your direct messages with that member
//   Paging:
//   ?after_id=123         only messages newer than this id (oldest first)
//   ?before_id=123        page backwards through history
//   ?limit=50             1-200, default 50
//   ?wait=25              with after_id: hold the request open up to N seconds
//                         until a new message arrives (long-polling)
//   ?from_others=1        ignore your own messages (useful with wait)
//   ?mark_read=0          don't record read receipts (default: mark as read)
//
// POST /api/messages
//   { "text": "hi" }                                   to the group
//   { "text": "hi", "to": "<username>" }               private message
//   { "text": "yes!", "reply_to_id": 123 }             quoted reply
//   { "text": "caption", "file": { "name": "a.png", "type": "image/png", "base64": "..." } }
//   { "text": "caption", "file_url": "https://...", "file_name": "report.pdf" }
export default route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    const q = req.query
    const limit = clamp(Number(q.limit) || 50, 1, 200)
    const fromOthers = q.from_others === '1' || q.from_others === 'true'
    const wait = clamp(Number(q.wait) || 0, 0, MAX_WAIT_SECONDS)
    const shouldMarkRead = q.mark_read !== '0' && q.mark_read !== 'false'

    // Built once; a fresh query is made from it on every poll.
    let scope
    if (q.with) {
      const peer = await userIdFor(sb, q.with)
      scope = (query) =>
        query.or(`and(user_id.eq.${userId},recipient_id.eq.${peer}),and(user_id.eq.${peer},recipient_id.eq.${userId})`)
    } else if (q.conversation === 'group') {
      scope = (query) => query.is('recipient_id', null)
    } else {
      scope = (query) => query.or(`recipient_id.is.null,recipient_id.eq.${userId},user_id.eq.${userId}`)
    }
    const base = () => {
      let query = scope(sb.from('messages').select('*'))
      if (fromOthers) query = query.neq('user_id', userId)
      return query
    }

    let rows
    if (q.after_id != null) {
      const afterId = Number(q.after_id)
      const deadline = Date.now() + wait * 1000
      for (;;) {
        rows = check(await base().gt('id', afterId).order('id').limit(limit))
        if (rows.length || Date.now() >= deadline) break
        await sleep(POLL_MS)
      }
    } else {
      let query = base().order('id', { ascending: false }).limit(limit)
      if (q.before_id != null) query = query.lt('id', Number(q.before_id))
      rows = check(await query).reverse()
    }

    const [messages] = await Promise.all([present(sb, rows), shouldMarkRead ? markRead(sb, userId, rows) : null])
    return { messages }
  },

  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = body(req)
    let text = typeof b.text === 'string' ? b.text.trim() : ''
    const recipientId = b.to ? await userIdFor(sb, b.to) : null
    if (recipientId === userId) throw new HttpError(400, "You can't send a private message to yourself")
    const replyToId = b.reply_to_id != null ? Number(b.reply_to_id) : null
    if (replyToId != null) {
      // The quoted message must be one you can see, in the same conversation.
      const original = check(
        await sb.from('messages').select('user_id, recipient_id').eq('id', replyToId).maybeSingle(),
      )
      if (!original) throw new HttpError(404, 'reply_to_id: message not found')
      const sameConversation = recipientId
        ? [original.user_id, original.recipient_id].sort().join() === [userId, recipientId].sort().join()
        : !original.recipient_id
      if (!sameConversation) throw new HttpError(400, 'reply_to_id must be a message in the same conversation')
    }
    let file = await readFile(b)
    let voiceDuration = null
    if (b.as_voice) {
      // Speak the text and send it as a voice note instead of a text message.
      if (file) throw new HttpError(400, 'Use either as_voice or a file, not both')
      const me = check(await sb.from('profiles').select('username').eq('id', userId).single())
      const spoken = await speak(text, voiceFor(me.username, b.voice))
      file = spoken
      voiceDuration = spoken.duration
      text = ''
    }
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
        ...(file.type.startsWith('audio/') && Number(voiceDuration ?? b.duration ?? b.file?.duration) > 0
          ? { attachment_duration: Number(voiceDuration ?? b.duration ?? b.file?.duration) }
          : {}),
      }
    }

    const { data, error } = await sb
      .from('messages')
      .insert({ content: text || null, recipient_id: recipientId, reply_to_id: replyToId, ...attachment })
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
