// Group Chat service worker: web push only. It never reads, sends, or
// stores chat messages itself; it only shows the notification payload a
// server-side sender already addressed to this device, and opens the
// conversation that payload names when the notification is tapped.
//
// The payload shape the sender must use (see docs/web-push.md):
//   { title, body, view: { type: 'group' }
//             | { type: 'dm', peerId }
//             | { type: 'owner', aId, bId } }
// A payload with no view, or a view the subscriber cannot read, is still
// shown as a plain "New message" notice that opens the group chat, so a
// malformed payload can never leak a DM to the wrong device: the server
// is responsible for addressing pushes only to participants, and the
// app itself enforces DM/owner visibility when the conversation opens.

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Group Chat'
  const body = typeof data.body === 'string' && data.body ? data.body : 'New message'
  const view = data.view && typeof data.view === 'object' ? data.view : { type: 'group' }
  const url = viewUrl(view)
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: notificationTag(view),
      data: { view, url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { view, url } = event.notification.data || {}
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus()
          // If the app is already open, tell it to open the conversation
          // instead of opening a second tab.
          client.postMessage({ type: 'open-conversation', view: view || { type: 'group' } })
          return
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url || '/')
    })(),
  )
})

// One notification per conversation: a new push for the same conversation
// replaces the previous one instead of stacking on the lock screen.
function notificationTag(view) {
  if (!view) return 'group'
  if (view.type === 'dm') return `dm:${view.peerId}`
  if (view.type === 'owner') return `owner:${[view.aId, view.bId].sort().join('|')}`
  if (view.type === 'group' && view.groupId) return `group:${view.groupId}`
  return 'group'
}

function viewUrl(view) {
  if (!view) return '/'
  if (view.type === 'dm' && view.peerId) return `/?view=dm&peer=${encodeURIComponent(view.peerId)}`
  if (view.type === 'owner' && view.aId && view.bId) {
    return `/?view=owner&a=${encodeURIComponent(view.aId)}&b=${encodeURIComponent(view.bId)}`
  }
  if (view.type === 'group' && view.groupId) return `/?view=group&group=${encodeURIComponent(view.groupId)}`
  return '/?view=group'
}
