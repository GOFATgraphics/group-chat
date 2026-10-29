# Web push for Group Chat

How a member gets a notification on their lock screen even when the app
is closed. This document contains no secrets and no keys. Nothing here
is a live backend: the sender described in section 4 is still to be
built and deployed, so push cannot go live until sections 4-5 are done.

## 1. What already exists in the app (local build only)

- `public/sw.js`: the service worker. It handles `push` (shows a
  notification from the payload) and `notificationclick` (focuses an
  already-open app window and tells it to open the conversation, or
  opens the app at a deep link: `/?view=dm&peer=<id>`,
  `/?view=owner&a=<id>&b=<id>`, or `/?view=group`). The app reads that
  URL on cold start and listens for the service worker's
  `open-conversation` message while it is open.
- The Push toggle in the People sheet (next to Sounds and
  Notifications). Turning it on registers the service worker, asks for
  push permission only at that moment, creates a PushSubscription with
  the VAPID public key from `VITE_VAPID_PUBLIC_KEY`, and stores the
  subscription in `push_subscriptions` (migration `0006`).
- The in-app toast, the browser Notification while the tab is open, and
  the unread/title badge are separate from push and keep working
  whether push is on or off.

## 2. Subscription storage

Table `push_subscriptions` (migration `0006_push_subscriptions.sql`,
unapplied): `user_id` references `profiles`, `endpoint` unique,
`keys` JSONB (the browser-generated `p256dh`/`auth` keys), `created_at`.
RLS: a member can only manage their own rows. A subscription is only
ever used to push to its own owner.

## 3. Payload shape

The sender must send JSON of this shape, and nothing more:

```json
{
  "title": "ali · Group Chat",
  "body": "Hi everyone, quick question…",
  "view": { "type": "group" }
}
```

`view` is `{ type: 'group' }`, `{ type: 'dm', peerId }`, or
`{ type: 'owner', aId, bId }`. The body is a short preview only, the
same preview the in-app toast shows (text truncated, or "sent a
photo/file" for attachments). The service worker never fetches message
content itself.

## 4. Sending (to be built, not in this task)

The intended route, in order:

1. A database webhook on `messages` INSERT (Supabase Database Webhooks)
   calls a server-side sender: a Supabase Edge Function or a Vercel
   function. No sender function is shipped in this change, and no stub
   that could send is included, so nothing can push until this is
   built and deployed.
2. The sender reads the new message's `user_id` and `recipient_id` and
   works out the recipients, and only those recipients:
   - Group message (`recipient_id` null): every member except the
     sender.
   - DM: the recipient only. Never any other member, and never the
     sender.
   - A DM between two other members: no push to the owner for that
     message. The owner view is read-only monitoring inside the app;
     it does not make the owner a recipient. (If the owner is a
     participant in a DM, they get that DM's push as a participant,
     not as owner.)
3. For each recipient, the sender loads that recipient's rows from
   `push_subscriptions` and sends a web-push message to each endpoint
   with the payload in section 3, signed with the VAPID private key.
4. On a `410 Gone` / `404 Not Found` response from a push service, the
   sender deletes that subscription row: the device unsubscribed or the
   subscription expired, and retrying it would be spam.

## 5. Secrets and env values still needed before go-live

Nothing below exists yet, and nothing below may be committed to the
repo or put in client code:

- A VAPID key pair, generated once (for example with the `web-push`
  library's `generateVAPIDKeys()` on a developer machine, never in the
  app). The public key goes in the app's env as
  `VITE_VAPID_PUBLIC_KEY` (Vercel env vars for the group-chat project,
  all environments). Until it is set, the Push toggle reports "Push is
  not configured yet" and stays off; no key is invented.
- The private key goes only in the sender's server secret store
  (Supabase Edge Function secrets, or Vercel env vars marked for the
  server function only, never exposed to the browser). It must never
  appear in the repo, in `public/`, or in any client bundle.
- The `0006` migration must be applied to live Supabase before the
  toggle can store a subscription; until then subscribing fails with
  the database error shown in settings, and the subscription is
  removed again so no orphan subscription is left behind.
- The sender from section 4 must be built, deployed, and pointed at
  by the database webhook, and tested end to end (see section 7).

## 6. Lock-screen honesty, and the install steps

Web push is the only route that reaches a locked phone, and it has
platform conditions the app cannot override:

- **iPhone / iOS 16.4+ (Safari):** web push only works for a web app
  that has been **installed to the home screen** as a PWA, with
  notifications allowed for that installed app. If the app is only
  opened in a normal Safari tab and never installed, lock-screen push
  will not arrive, no matter what the code does. Install steps:
  1. Open the group-chat site in Safari (not in an in-app browser).
  2. Tap Share, then "Add to Home Screen", then Add.
  3. Open the app from the new home-screen icon and sign in.
  4. In the People sheet, turn on Push notifications and allow
     notifications when asked.
  5. In iOS Settings > Notifications > Group Chat, confirm "Allow
     Notifications" is on and "Lock Screen" is ticked. The app cannot
     change those settings itself.
- **Android / Chrome:** web push works once subscribed, even when the
  browser is closed, without installing. Installing to the home
  screen is still recommended so the notification opens the app.
- **Desktop Chrome/Edge/Firefox:** push arrives while the browser is
  running (including in the background on most systems); if the
  browser is fully closed, delivery depends on the OS and browser.
- In all cases push permission must be granted, and the device's
  notification settings for the app/browser must allow lock-screen
  display. If permission was denied, the toggle stays off and the user
  must re-allow it in browser/OS settings; the app never re-prompts
  on its own.

## 7. Live-check list (parent to run after push goes live)

1. Apply migration `0006`, set `VITE_VAPID_PUBLIC_KEY`, deploy the
   sender, and wire the messages-INSERT webhook.
2. On a test device, install the app (iOS) or open it (Android),
   turn on Push, and confirm a subscription row appears for that user
   only.
3. From a second account, send a group message: the first device gets
   a lock-screen notification, tapping it opens the group chat.
4. From a second account, send a DM to the first device only: it gets
   the DM notification; a third member's device gets nothing.
5. Send a DM between two other members: the owner gets no push for
   it, and opening the owner view still works read-only in the app.
6. Turn push off in settings: the subscription row is deleted and no
   further pushes arrive.
7. Confirm the in-app toast, browser Notification, unread badge,
   swipe-to-reply, and reply quotes all still work with push on and
   with push off.
