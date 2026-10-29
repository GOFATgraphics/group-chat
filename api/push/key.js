import { route } from '../_lib.js'
import { ensurePushConfig } from './_config.js'

// GET /api/push/key -> { publicKey }
// The app calls this when someone turns push on. The first call sets push up:
// it creates the VAPID key pair and points the database at the sender.
export default route({
  async GET() {
    const cfg = await ensurePushConfig()
    return { publicKey: cfg.vapid_public_key, sender: cfg.url ? 'ready' : 'not a production deployment' }
  },
})
