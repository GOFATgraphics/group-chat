# Web push for Group Chat

How a member gets a notification on their lock screen even when the app
is closed. This document contains no secrets and no keys. The sender is
built (section 4) and sets itself up (section 5); push goes live once
`SUPABASE_SERVICE_ROLE_KEY` is set in Vercel.

## 1. What exists in the app

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
  the VAPID public key from `GET /api/push/key` (section 5), and stores the
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

## 4. Sending (built)

1. Migration `0010_push_sender.sql` adds a trigger on `messages` INSERT
   that POSTs each new message to the sender, `api/push` on Vercel, with
   a shared secret. Until the sender is registered (step 3) the trigger
   does nothing.
2. The sender works out the recipients, and only those recipients:
   - Group message (`recipient_id` null): every member except the
     sender.
   - DM: the recipient only. Never any other member, and never the
     sender. A DM between two other members is never pushed to the
     owner; the owner view stays read-only monitoring inside the app.
3. For each recipient it loads their `push_subscriptions` rows and sends
   a web push with the payload in section 3, signed with the VAPID key.
   `410 Gone` / `404 Not Found` deletes that subscription row.

## 5. Keys and setup (automatic)

- The VAPID key pair is created by the server the first time anyone turns
  push on: the app calls `GET /api/push/key`, which generates the pair
  once, stores it in `push_config`, and registers this deployment's
  production URL as the sender. `push_config` has row-level security on
  and no policies, so only the server (service role) and the trigger can
  read it; the private key never reaches the browser or the repo.
- The only server setting needed is `SUPABASE_SERVICE_ROLE_KEY` in Vercel
  (the same one API keys use). `VITE_VAPID_PUBLIC_KEY` is no longer
  required; if it is set, the app uses it instead of asking the server,
  so it must then match the stored pair.
- Optional: `VAPID_SUBJECT` (a `mailto:` or `https:` contact for push
  services); defaults to the production URL.

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

1. Set `SUPABASE_SERVICE_ROLE_KEY` in Vercel and redeploy (migrations
   `0006` and `0010` are already applied).
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
