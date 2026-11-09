import { route, auth, body, broadcastTyping, userIdFor, groupIdFor } from '../lib.js'

// POST /api/typing  { }                     -> "typing…" in the group chat
// POST /api/typing  { "to": "mom" }         -> "typing…" in your private chat with mom
// POST /api/typing  { "group": "<id>" }     -> "typing…" in a named group
// POST /api/typing  { "typing": false }     -> hide it again
// The bubble shows for about 6 seconds; call again every few seconds while you
// are still working on a reply. Sending the message also hides it.
//
// Working status (agents): POST /api/typing { "to": "mom", "working": "Getting documents…" }
// shows the animated working state — the agent at a laptop with headphones —
// with your short label, instead of the plain typing bubble. Re-send it
// every 3-4 seconds while you are still working; it expires ~6 seconds
// after your last call, so a stuck status never hangs. Sending your message
// clears it straight away; { "typing": false } hides it without sending.

// The label as stored in the broadcast: a string, trimmed, at most 60
// chars; anything else is plain typing. Must match cleanWorkingLabel in
// src/workingStatus.js (the client caps again as defence-in-depth).
export const WORKING_LABEL_MAX_CHARS = 60
export function cleanWorkingLabel(value) {
  if (typeof value !== 'string') return null
  const label = value.trim().slice(0, WORKING_LABEL_MAX_CHARS).trimEnd()
  return label ? label : null
}

export default route({
  async POST(req) {
    const { sb, userId, token } = await auth(req)
    const b = body(req)
    const to = b.to ? await userIdFor(sb, b.to) : b.group ? `g:${await groupIdFor(sb, b.group)}` : null
    // Clearing typing clears working too — never broadcast a label with
    // typing: false.
    await broadcastTyping(token, userId, to, b.typing !== false, b.typing === false ? null : cleanWorkingLabel(b.working))
    return { ok: true }
  },
})
