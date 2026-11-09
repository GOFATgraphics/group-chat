// Group Chat — iPhone lock screen widget (Scriptable)
//
// A web app cannot install a native iOS lock-screen widget by itself, so
// this script is the widget: it fetches your own unread count, latest
// message, AI agent avatar and credit balance from the group-chat
// server and draws the lock-screen widget. Tapping the widget opens
// the app.
//
// Setup (see Settings → Lock screen widget in the app):
//   1. Create a personal API key in the app (Settings → API keys).
//   2. Paste it below where it says PASTE_YOUR_KEY_HERE.
//   3. In Scriptable, add this as a script, then add the Scriptable
//      widget to your lock screen and pick this script.
//
// Keep the key secret — anyone holding it can read and reply as you.
// Revoke it in the app (Settings → API keys) if it leaks.

const WIDGET_KEY = 'PASTE_YOUR_KEY_HERE'
const API_URL = 'https://quantumy.work/api/widget'
const APP_URL = 'https://quantumy.work'

// --- data -----------------------------------------------------------------
// The key goes in the Authorization header, never in the URL, so it does
// not land in a server log. Returns { data } or { error } — never throws.

async function loadData() {
  try {
    // Trim the key: a copy-paste from chat often picks up a stray space
    // or newline, and a padded key hashes to the wrong value (the
    // server trims too, but the script should not send a padded key).
    const key = String(WIDGET_KEY || '').trim()
    if (!key || key === 'PASTE_YOUR_KEY_HERE') return { error: 'no-key' }
    const req = new Request(API_URL)
    req.headers = { Authorization: 'Bearer ' + key }
    // 30s: Render's free tier takes 50s+ to wake from a cold start, so
    // 15s was too short; 60s risks iOS killing the widget run. Even
    // 30s may not cover a fully cold start — the first tap wakes
    // Render, and the retry then succeeds (SPEC §11).
    req.timeoutInterval = 30
    const data = await req.loadJSON()
    if (!data || typeof data.unread !== 'number') return { error: 'bad-data' }
    const result = { data }
    // The agent's avatar (SPEC §10): one small image, short timeout,
    // and any failure falls back silently to the text-only layout —
    // the widget must never block on the image or show a broken one.
    if (data.agent && data.agent.avatarUrl) {
      try {
        const imgReq = new Request(data.agent.avatarUrl)
        imgReq.timeoutInterval = 8
        result.avatarImage = await imgReq.loadImage()
      } catch (e) {
        // No avatar image — the widget renders without it.
      }
    }
    return result
  } catch (e) {
    return { error: 'fetch-failed' }
  }
}

// --- text helpers ---------------------------------------------------------

function creditsLine(d) {
  if (d.outOfCredits) return 'Out of credits — resets ' + (d.weekReset || 'Mon')
  const free = Number(d.freeRemaining || 0)
  const extra = Number(d.additionalRemaining || 0)
  const total = Math.round((free + extra) * 100) / 100
  return total + ' credits left'
}

function shortText(text, max) {
  const t = String(text || '')
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

// --- widget ---------------------------------------------------------------

// What the error state says (SPEC §11): each failure gets its own short
// reason, so the lock screen itself tells the user what is wrong instead
// of the same generic line for every cause. Unknown values fall back to
// the most common cause (the server could not be reached).
const ERROR_LINES = {
  'no-key': 'Add your key in the script',
  'fetch-failed': "Couldn't reach the server",
  'bad-data': 'Unexpected reply',
}

function buildWidget(result) {
  const w = new ListWidget()
  w.url = APP_URL
  if (result.error) {
    const title = w.addText('Group Chat')
    title.font = Font.systemFont(13, 'semibold')
    title.textColor = Color.white()
    const reason = w.addText(ERROR_LINES[result.error] || ERROR_LINES['fetch-failed'])
    reason.font = Font.systemFont(12)
    reason.textColor = Color.white()
    // "Tap to retry": with "Run Script" set, tapping re-runs the script
    // (refresh) instead of opening the app — "Tap to open" was
    // misleading. widget.url is unchanged, so Open App behaviour stays.
    const hint = w.addText('Tap to retry')
    hint.font = Font.systemFont(11)
    hint.textColor = Color.white()
    return w
  }
  const d = result.data
  const family = config.widgetFamily

  if (family === 'accessoryCircular') {
    const num = w.addText(String(d.unread))
    num.font = Font.systemFont(22, 'bold')
    num.textColor = Color.white()
    num.centerAlignText()
    return w
  }

  if (family === 'accessoryInline') {
    const line = w.addText(d.unread + ' new • ' + creditsLine(d))
    line.font = Font.systemFont(12)
    line.textColor = Color.white()
    return w
  }

  // accessoryRectangular, and any home-screen size as a fallback.
  // With an avatar (SPEC §10): a horizontal row — the agent's photo,
  // small and round, at the left of the title line. Without one (or if
  // the image failed to load), the text-only layout, exactly as before.
  if (result.avatarImage) {
    const row = w.addStack()
    row.layoutHorizontally()
    row.centerAlignContent()
    row.spacing = 8
    const photo = row.addImage(result.avatarImage)
    photo.imageSize = new Size(28, 28)
    photo.cornerRadius = 14
    const col = row.addStack()
    col.layoutVertically()
    const title = col.addText('Group Chat' + (d.unread > 0 ? '  •  ' + d.unread + ' new' : ''))
    title.font = Font.systemFont(13, 'semibold')
    title.textColor = Color.white()
  } else {
    const title = w.addText('Group Chat' + (d.unread > 0 ? '  •  ' + d.unread + ' new' : ''))
    title.font = Font.systemFont(13, 'semibold')
    title.textColor = Color.white()
  }
  if (d.latest && d.latest.text) {
    w.addSpacer(4)
    const latest = w.addText(shortText(d.latest.from + ': ' + d.latest.text, 64))
    latest.font = Font.systemFont(12)
    latest.textColor = Color.white()
  }
  w.addSpacer(4)
  const credits = w.addText(creditsLine(d))
  credits.font = Font.systemFont(12)
  credits.textColor = Color.white()
  return w
}

// --- run ------------------------------------------------------------------

const result = await loadData()
const widget = buildWidget(result)

// Ask iOS to refresh the widget regularly (every 5 minutes): without
// this, iOS only refreshes on its own schedule and the widget can sit
// on stale data until it is re-run by hand. iOS treats this as a
// request, not a guarantee — it enforces its own minimum (about 15
// minutes for a widget like this) and may refresh later to save
// battery, so asking for 1–2 minutes would not make it refresh any
// faster. 5 minutes is the shortest worth asking for. Tapping still
// forces an immediate refresh.
widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000)

if (config.runsInApp) {
  // Preview inside the Scriptable app, with the short setup steps.
  widget.presentSmall()
  const alert = new Alert()
  alert.title = 'Group Chat widget'
  alert.message =
    'This script draws your lock-screen widget from quantumy.work.\n\n' +
    '1. Create an API key in the app (Settings → API keys).\n' +
    '2. Paste it at the top where it says PASTE_YOUR_KEY_HERE.\n' +
    '3. Add the Scriptable widget to your lock screen and pick this script.'
  alert.addAction('OK')
  await alert.present()
} else {
  Script.setWidget(widget)
}
Script.complete()
