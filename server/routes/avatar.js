import { route, auth, body, check, HttpError, SUPABASE_URL } from '../lib.js'
import { readFile } from './messages.js'

// Your profile photo (what everyone sees next to your messages).
//   GET    /api/avatar                                   -> { avatar_url }
//   PUT    /api/avatar { "file": { "type": "image/png", "base64": "..." } }
//   PUT    /api/avatar { "file_url": "https://..." }     (the server downloads it)
//   DELETE /api/avatar                                   -> back to your initial
// JPEG, PNG, WebP or GIF up to 5 MB. A square image looks best; others are
// shown cropped to a circle.
const BUCKET = 'avatars'
const MAX_BYTES = 5 * 1024 * 1024
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
const publicUrl = (path) => (path ? `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}` : null)

async function current(sb, userId) {
  return check(await sb.from('profiles').select('avatar_path').eq('id', userId).single()).avatar_path
}

async function setAvatar(req) {
  const { sb, userId } = await auth(req)
  const file = await readFile(body(req))
  if (!file) throw new HttpError(400, 'Send "file" ({ type, base64 }) or "file_url"')
  const type = file.type === 'image/jpg' ? 'image/jpeg' : file.type
  if (!EXT[type]) throw new HttpError(415, 'The photo must be JPEG, PNG, WebP or GIF')
  if (file.bytes.length > MAX_BYTES) throw new HttpError(413, 'The photo must be 5 MB or smaller')
  const old = await current(sb, userId)
  const path = `${userId}/${Date.now()}.${EXT[type]}`
  const { error } = await sb.storage.from(BUCKET).upload(path, file.bytes, { contentType: type })
  if (error) throw new HttpError(400, `Upload failed: ${error.message}`)
  const { error: err } = await sb.from('profiles').update({ avatar_path: path }).eq('id', userId)
  if (err) {
    await sb.storage.from(BUCKET).remove([path])
    throw new HttpError(400, err.message)
  }
  if (old && old !== path) await sb.storage.from(BUCKET).remove([old])
  return { avatar_url: publicUrl(path) }
}

export default route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    return { avatar_url: publicUrl(await current(sb, userId)) }
  },
  PUT: setAvatar,
  POST: setAvatar,
  async DELETE(req) {
    const { sb, userId } = await auth(req)
    const old = await current(sb, userId)
    check(await sb.from('profiles').update({ avatar_path: null }).eq('id', userId))
    if (old) await sb.storage.from(BUCKET).remove([old])
    return { avatar_url: null }
  },
})
