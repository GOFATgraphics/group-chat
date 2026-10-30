import {
  route, auth, body, check, present, markRead, userIdFor, groupIdFor, sleep, HttpError, BUCKET, MAX_FILE_BYTES,
} from '../lib.js'
import { speak, voiceFor, mp3Duration } from '../speech.js'
import { takeDueTasks } from './tools.js'

const MAX_WAIT_SECONDS = 25
const POLL_MS = 150

// GET /api/messages
//   Which conversation (default: the group chat plus your own direct messages):
//   ?conversation=group   the main group chat only
//   ?group=<id or name>   only that named group
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
//   { "text": "hi", "group": "<group id or name>" }     a named group
//   With only reply_to_id, the reply goes to the quoted message's conversation.
//   { "text": "yes!", "reply_to_id": 123 }             quoted reply
//   { "text": "caption", "file": { "name": "a.png", "type": "image/png", "base64": "..." } }
//   { "text": "caption", "file_url": "https://...", "file_name": "report.pdf" }
//   { "text": "caption", "files": [{ "name": "a.png", "type": "image/png", "base64": "..." }, ...] }
//   files[] is one message with up to 5 attachments, in order. The first
//   file is also kept in the legacy attachment_* columns (see 0018).
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
    } else if (q.group) {
      const groupId = await groupIdFor(sb, q.group)
      scope = (query) => query.eq('group_id', groupId)
    } else if (q.conversation === 'group') {
      scope = (query) => query.is('recipient_id', null).is('group_id', null)
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

    const [messages, dueTasks] = await Promise.all([
      present(sb, rows),
      takeDueTasks(sb),
      shouldMarkRead ? markRead(sb, userId, rows) : null,
    ])
    return dueTasks.length ? { messages, due_tasks: dueTasks } : { messages }
  },

  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = body(req)
    let text = typeof b.text === 'string' ? b.text.trim() : ''
    const replyToId = b.reply_to_id != null ? Number(b.reply_to_id) : null
    const original = replyToId != null
      ? check(await sb.from('messages').select('user_id, recipient_id, group_id').eq('id', replyToId).maybeSingle())
      : null
    if (replyToId != null && !original) throw new HttpError(404, 'reply_to_id: message not found')
    let recipientId = b.to ? await userIdFor(sb, b.to) : null
    let groupId = b.group ? await groupIdFor(sb, b.group) : null
    if (recipientId && groupId) throw new HttpError(400, 'Send to either "to" or "group", not both')
    if (original && !b.to && !b.group) {
      // No conversation given: answer where the quoted message was.
      groupId = original.group_id ?? null
      recipientId = original.recipient_id ? (original.user_id === userId ? original.recipient_id : original.user_id) : null
    }
    if (recipientId === userId) throw new HttpError(400, "You can't send a private message to yourself")
    if (original) {
      // The quoted message must be one you can see, in the same conversation.
      const sameConversation = recipientId
        ? [original.user_id, original.recipient_id].sort().join() === [userId, recipientId].sort().join()
        : !original.recipient_id && (original.group_id ?? null) === groupId
      if (!sameConversation) throw new HttpError(400, 'reply_to_id must be a message in the same conversation')
    }
    // Multi-file: up to 5, one message. Checked before the single-file path.
    let files = null
    if (Array.isArray(b.files)) {
      if (b.files.length === 0) throw new HttpError(400, 'Send "text", "file" or "files"')
      if (b.files.length > 5) throw new HttpError(400, 'Maximum 5 files at a time')
      if (b.as_voice) throw new HttpError(400, 'Use either as_voice or files, not both')
      files = await readFiles(b.files)
    }
    let file = files ? null : await readFile(b)
    let voiceDuration = null
    let voiceError = null
    if (b.as_voice) {
      // Speak the text and send it as a voice note instead of a text message.
      if (file) throw new HttpError(400, 'Use either as_voice or a file, not both')
      const me = check(await sb.from('profiles').select('username').eq('id', userId).single())
      try {
        const spoken = await speak(text, voiceFor(me.username, b.voice))
        file = spoken
        voiceDuration = spoken.duration
        text = ''
      } catch (err) {
        // No speech available (e.g. AI Gateway has no credits): still deliver
        // the reply, as text, and say why in the response.
        voiceError = err.message
      }
    }
    if (!text && !file && !files) throw new HttpError(400, 'Send "text", "file" or "file_url"')
    if (file && voiceDuration == null && /^audio\/(mpeg|mp3)$/.test(file.type) && !(Number(b.duration ?? b.file?.duration) > 0)) {
      // Uploaded mp3 without a length: measure it so the voice note shows its time.
      try {
        voiceDuration = mp3Duration(Buffer.from(file.bytes)) || null
      } catch {
        // unknown length is fine
      }
    }

    let attachment = {}
    let uploadedPaths = []
    if (files) {
      // Upload every file first, in order, then save one message row.
      const uploaded = []
      for (const f of files) {
        const safeName = f.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file'
        const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
        const { error } = await sb.storage.from(BUCKET).upload(path, f.bytes, { contentType: f.type })
        if (error) {
          if (uploadedPaths.length) await sb.storage.from(BUCKET).remove(uploadedPaths)
          throw new HttpError(400, `Upload failed: ${error.message}`)
        }
        uploadedPaths.push(path)
        uploaded.push({ ...f, path })
      }
      const first = uploaded[0]
      attachment = {
        attachment_path: first.path,
        attachment_name: first.name,
        attachment_type: first.type,
        attachment_size: first.bytes.length,
      }
      // Saved after the message row below, so a failed message insert
      // never leaves attachment rows pointing at a missing message.
      files = uploaded
    } else if (file) {
      const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file'
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
      const { error } = await sb.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.type })
      if (error) throw new HttpError(400, `Upload failed: ${error.message}`)
      uploadedPaths.push(path)
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
      .insert({ content: text || null, recipient_id: recipientId, group_id: groupId, reply_to_id: replyToId, ...attachment })
      .select()
      .single()
    if (error) {
      if (uploadedPaths.length) await sb.storage.from(BUCKET).remove(uploadedPaths)
      check({ error })
    }
    if (files) {
      // Best-effort extra rows: the message itself is already saved with
      // the first file in its legacy columns, so a missing extra row is
      // never a lost message, only a missing second picture. Report it
      // in the response rather than deleting the whole message.
      const { error: attErr } = await sb.from('message_attachments').insert(
        files.map((f, i) => ({
          message_id: data.id,
          position: i,
          attachment_path: f.path,
          attachment_name: f.name,
          attachment_type: f.type,
          attachment_size: f.bytes.length,
        })),
      )
      if (attErr) {
        const [message] = await present(sb, [data])
        return { message, attachments_warning: `Message saved, but extra attachments could not be saved: ${attErr.message}` }
      }
    }
    const [message] = await present(sb, [data])
    return voiceError ? { message, voice_error: `Sent as text instead: ${voiceError}` } : { message }
  },
})

export async function readFiles(list) {
  const out = []
  for (const item of list) {
    if (!item?.base64) throw new HttpError(400, 'Each file in "files" needs base64, name and type')
    const bytes = Buffer.from(item.base64, 'base64')
    if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, 'Files must be 25 MB or smaller')
    out.push({ bytes, name: item.name || 'file', type: item.type || 'application/octet-stream' })
  }
  return out
}

export async function readFile(b) {
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
