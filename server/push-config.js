import webpush from 'web-push'
import { admin, HttpError } from './lib.js'

// Push settings live in the push_config table (service role only). The
// VAPID key pair is created on first use and the sender URL is kept pointed
// at this deployment's production address.

export const productionHost = () => process.env.VERCEL_PROJECT_PRODUCTION_URL || null

let cached = null

export async function pushConfig({ fresh = false } = {}) {
  if (cached && !fresh && Date.now() - cached.at < 60_000) return cached.value
  const adm = admin()
  const { data, error } = await adm.from('push_config').select('*').eq('id', true).maybeSingle()
  if (error) throw new HttpError(500, error.message)
  cached = { value: data, at: Date.now() }
  return data
}

// Creates the VAPID keys once, and registers this deployment as the sender.
export async function ensurePushConfig() {
  const adm = admin()
  let cfg = await pushConfig({ fresh: true })
  if (!cfg?.vapid_public_key) {
    const keys = webpush.generateVAPIDKeys()
    // Insert-if-missing, so two first calls at once can't create two key pairs.
    const { error } = await adm
      .from('push_config')
      .upsert(
        { id: true, vapid_public_key: keys.publicKey, vapid_private_key: keys.privateKey },
        { onConflict: 'id', ignoreDuplicates: true },
      )
    if (error) throw new HttpError(500, error.message)
    cfg = await pushConfig({ fresh: true })
    if (!cfg?.vapid_public_key) {
      // A row existed without keys: fill them in.
      const { error: e2 } = await adm
        .from('push_config')
        .update({ vapid_public_key: keys.publicKey, vapid_private_key: keys.privateKey })
        .eq('id', true)
        .is('vapid_public_key', null)
      if (e2) throw new HttpError(500, e2.message)
      cfg = await pushConfig({ fresh: true })
    }
  }
  const host = productionHost()
  const url = host ? `https://${host}/api/push` : null
  if (url && cfg.url !== url) {
    const { error } = await adm.from('push_config').update({ url, updated_at: new Date().toISOString() }).eq('id', true)
    if (error) throw new HttpError(500, error.message)
    cfg = await pushConfig({ fresh: true })
  }
  return cfg
}
