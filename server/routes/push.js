// Push sender. The database POSTs every new message here (see migration
// 0010); we work out who should hear about it and send them a web push.
//   Group message: every member except the sender.
//   Direct message: the recipient only (never the owner of the group, never
//   anyone else; see docs/web-push.md).
// Subscriptions that the push service reports as gone are deleted.

import webpush from 'web-push'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'node:crypto'
import { admin } from '../lib.js'
import { pushConfig, productionHost } from '../push-config.js'

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    let cfg = await pushConfig()
    if (!secretMatches(req.headers.authorization, cfg?.secret)) {
      cfg = await pushConfig({ fresh: true })
      if (!secretMatches(req.headers.authorization, cfg?.secret)) return res.status(401).json({ error: 'Bad secret' })
    }
    const message = req.body?.message
    if (req.body?.type !== 'message.created' || !message?.id) return res.status(400).json({ error: 'Unexpected payload' })
    waitUntil(send(cfg, message).catch((err) => console.error('push failed', err)))
    return res.status(202).json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(err.status || 500).json({ error: err.message })
  }
}

function secretMatches(header, secret) {
  if (!secret || !header?.startsWith('Bearer ')) return false
  const a = Buffer.from(header.slice(7))
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function send(cfg, m) {
  if (!cfg?.vapid_public_key || !cfg?.vapid_private_key) return { sent: 0 }
  const adm = admin()
  const { data: profiles } = await adm.from('profiles').select('id, username')
  const names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.username]))

  const recipients = m.recipient_id
    ? m.recipient_id !== m.user_id
      ? [m.recipient_id]
      : []
    : (profiles ?? []).map((p) => p.id).filter((id) => id !== m.user_id)
  if (!recipients.length) return { sent: 0 }

  const { data: subs } = await adm
    .from('push_subscriptions')
    .select('id, user_id, endpoint, keys')
    .in('user_id', recipients)
  if (!subs?.length) return { sent: 0 }

  const sender = names[m.user_id] ?? 'Someone'
  const payload = JSON.stringify({
    title: m.recipient_id ? sender : `${sender} · Group Chat`,
    body: preview(m),
    view: m.recipient_id ? { type: 'dm', peerId: m.user_id } : { type: 'group' },
  })
  const host = productionHost()
  const options = {
    vapidDetails: {
      subject: process.env.VAPID_SUBJECT || (host ? `https://${host}` : 'mailto:push@example.com'),
      publicKey: cfg.vapid_public_key,
      privateKey: cfg.vapid_private_key,
    },
    TTL: 24 * 60 * 60,
    urgency: 'high',
  }

  let sent = 0
  const gone = []
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, options)
        sent++
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) gone.push(s.id)
        else console.error('push to one device failed', err.statusCode, err.body)
      }
    }),
  )
  if (gone.length) await adm.from('push_subscriptions').delete().in('id', gone)
  return { sent, removed: gone.length }
}

// Short preview only, like the in-app notice.
function preview(m) {
  const text = (m.content ?? '').trim()
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text
  if (m.attachment_type?.startsWith('image/')) return 'sent a photo'
  if (m.attachment_type?.startsWith('video/')) return 'sent a video'
  if (m.attachment_type?.startsWith('audio/')) return '🎤 Voice note'
  if (m.attachment_name) return `sent a file: ${m.attachment_name}`
  return 'New message'
}
