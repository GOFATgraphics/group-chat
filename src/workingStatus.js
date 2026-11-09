// Pure presence state for the typing / working broadcast (src/typing.js
// and the server route share these rules). Dependency-free on purpose, so
// plain `node` can test it without React or Supabase.
//
// A presence entry is { to, until, working }: `to` is the conversation the
// event belongs to (null = main group chat, "g:<id>" = named group, a user
// id = a DM with that user), `until` is the time the entry expires, and
// `working` is the agent's short status label ("Getting documents…") or
// null for plain typing. A working status is just typing with a label —
// it rides the same heartbeat and the same ~6 s expiry, so a stuck
// status can never hang: it disappears on its own.

export const SHOW_FOR_MS = 6000
export const MAX_WORKING_LABEL_CHARS = 60

// The label as the client shows it: a string, trimmed, capped at 60
// chars; anything else becomes null (plain typing). Defence-in-depth —
// the server route sanitises too, but a client can broadcast directly
// over Realtime and bypass the route.
export function cleanWorkingLabel(value) {
  if (typeof value !== 'string') return null
  const label = value.trim().slice(0, MAX_WORKING_LABEL_CHARS).trimEnd()
  return label ? label : null
}

// Fold one broadcast payload into the presence map. `prev` is
// { userId: { to, until, working } }. Returns a new map (or `prev`
// unchanged when the payload carries nothing usable).
export function applyPresenceEvent(prev, payload, now = Date.now()) {
  const id = payload?.user_id
  if (!id) return prev
  const next = { ...prev }
  if (payload.typing === false) {
    // Hiding typing hides working too — one state, one clear.
    delete next[id]
    return next
  }
  next[id] = { to: payload.to ?? null, until: now + SHOW_FOR_MS, working: cleanWorkingLabel(payload.working) }
  return next
}

// Drop entries whose time has run out. Returns `prev` unchanged when
// nothing expired, so callers can skip a re-render.
export function sweepPresence(prev, now = Date.now()) {
  const live = Object.entries(prev).filter(([, v]) => v.until > now)
  return live.length === Object.keys(prev).length ? prev : Object.fromEntries(live)
}
