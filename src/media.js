import { supabase, BUCKET, SUPABASE_URL, SUPABASE_KEY } from './supabase.js'

// ---- before upload -------------------------------------------------------------

const MAX_SIDE = 2048

// Phone photos are often 3-12 MB. Re-encode large photos to a 2048 px JPEG
// (~0.3-0.8 MB), which uploads several times faster and still looks sharp.
// GIFs, small images and anything that isn't a photo are sent as they are.
export async function prepareForUpload(file) {
  const type = file.type || ''
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(type) || file.size < 400 * 1024) return file
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
      bitmap.close?.()
      return file
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff' // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return file
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' })
  } catch {
    return file
  }
}

// ---- upload ---------------------------------------------------------------------

// Uploads straight to Supabase Storage with XMLHttpRequest, because fetch (and
// so supabase-js) can't report upload progress. onProgress gets 0..1.
export async function uploadWithProgress(path, file, onProgress) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not signed in')
  const target = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', target)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', SUPABASE_KEY)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-upsert', 'false')
    xhr.setRequestHeader('cache-control', 'max-age=3600')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1)
        resolve()
      } else {
        let message = `Upload failed (HTTP ${xhr.status})`
        try {
          message = JSON.parse(xhr.responseText).message || message
        } catch {
          // keep the generic message
        }
        reject(new Error(message))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed: check your connection'))
    xhr.send(file)
  })
}

// ---- save / share ---------------------------------------------------------------

function clickLink(href, name) {
  const a = document.createElement('a')
  a.href = href
  if (name) a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// Images in formats phones and apps often can't open (WebP, AVIF, HEIC,
// e.g. an AI's generated picture) are converted before saving: to PNG when
// they have transparent areas, otherwise to JPEG. JPEG, PNG and GIF are kept.
const KEEP_IMAGE_TYPES = /^image\/(jpeg|png|gif)$/

async function toSavableImage(blob, name) {
  if (!blob.type.startsWith('image/') || KEEP_IMAGE_TYPES.test(blob.type)) return { blob, name }
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let transparent = false
    for (let i = 3; i < pixels.length; i += 4 * 16) {
      if (pixels[i] < 255) {
        transparent = true
        break
      }
    }
    let type = 'image/png'
    if (!transparent) {
      // JPEG has no transparency: paint on white first, then encode.
      const flat = document.createElement('canvas')
      flat.width = canvas.width
      flat.height = canvas.height
      const fctx = flat.getContext('2d')
      fctx.fillStyle = '#fff'
      fctx.fillRect(0, 0, flat.width, flat.height)
      fctx.drawImage(canvas, 0, 0)
      type = 'image/jpeg'
      const jpeg = await new Promise((resolve) => flat.toBlob(resolve, type, 0.92))
      if (jpeg) return { blob: jpeg, name: withExtension(name, 'jpg') }
    }
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    return png ? { blob: png, name: withExtension(name, 'png') } : { blob, name }
  } catch {
    return { blob, name }
  }
}

const withExtension = (name, ext) => `${String(name || 'image').replace(/\.[^./]+$/, '')}.${ext}`

async function fetchBlob(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.blob()
}

// Downloads a photo, video, voice note or file. Images are fetched and, if
// needed, converted to JPEG/PNG first. Other files use Supabase's
// ?download=<name>, which makes the browser save instead of open.
export async function saveMedia(url, name = 'download', type = '') {
  if (!url) return
  const looksLikeImage = type.startsWith('image/') || type === 'image' || /\.(webp|avif|heic|heif|png|jpe?g|gif)(\?|$)/i.test(name + ' ' + url.split('?')[0])
  if (looksLikeImage || url.startsWith('blob:') || !url.includes('/storage/v1/object/sign/')) {
    try {
      const saved = await toSavableImage(await fetchBlob(url), name)
      const local = URL.createObjectURL(saved.blob)
      clickLink(local, saved.name)
      setTimeout(() => URL.revokeObjectURL(local), 30_000)
      return
    } catch {
      if (!url.includes('/storage/v1/object/sign/')) return void window.open(url, '_blank', 'noopener')
    }
  }
  clickLink(`${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(name)}`)
}

export const canShareFiles = () => typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'

// On phones this opens the share sheet (iPhone: "Save Image" puts it in
// Photos). Images are converted to JPEG/PNG first. Falls back to a download.
export async function shareMedia(url, name = 'image', type = '') {
  try {
    const saved = await toSavableImage(await fetchBlob(url), name)
    const file = new File([saved.blob], saved.name, { type: saved.blob.type || type })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] })
      return
    }
  } catch (err) {
    if (err?.name === 'AbortError') return // the person closed the share sheet
  }
  await saveMedia(url, name, type)
}

// Image links inside a message's text (e.g. an AI posting a generated
// image): markdown ![alt](url) and bare links ending in an image extension.
const MD_IMAGE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
const BARE_IMAGE = /https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s)]*)?/gi

export function imageLinksIn(text) {
  if (typeof text !== 'string') return []
  const found = new Set()
  for (const m of text.matchAll(MD_IMAGE)) found.add(m[1])
  for (const m of text.replace(MD_IMAGE, ' ').matchAll(BARE_IMAGE)) found.add(m[0])
  return [...found].slice(0, 6)
}

// The text without markdown image syntax (those show as pictures instead).
export const withoutMarkdownImages = (text) => (typeof text === 'string' ? text.replace(MD_IMAGE, '').trim() : text)
