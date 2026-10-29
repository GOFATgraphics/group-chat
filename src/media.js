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

// Downloads a photo, video, voice note or file. Supabase signed URLs accept
// ?download=<name>, which makes the browser save instead of open. Other links
// (e.g. an image an AI posted) are fetched and saved under a file name.
export async function saveMedia(url, name = 'download') {
  if (!url) return
  if (url.startsWith('blob:')) return clickLink(url, name)
  if (url.includes('/storage/v1/object/sign/')) {
    return clickLink(`${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(name)}`)
  }
  try {
    const blob = await (await fetch(url)).blob()
    const local = URL.createObjectURL(blob)
    clickLink(local, name)
    setTimeout(() => URL.revokeObjectURL(local), 30_000)
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}

export const canShareFiles = () => typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'

// On phones this opens the share sheet (iPhone: "Save Image" puts it in
// Photos). Falls back to a normal download.
export async function shareMedia(url, name = 'image', type = '') {
  try {
    const blob = await (await fetch(url)).blob()
    const file = new File([blob], name, { type: blob.type || type })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] })
      return
    }
  } catch (err) {
    if (err?.name === 'AbortError') return // the person closed the share sheet
  }
  await saveMedia(url, name)
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
