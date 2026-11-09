// Group Chat — iPhone lock screen widget (Scriptable)
//
// A web app cannot install a native iOS lock-screen widget by itself, so
// this script is the widget: it fetches your own unread count, latest
// message and credit balance from the group-chat server and draws the
// lock-screen widget. Tapping the widget opens the app.
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
    if (!WIDGET_KEY || WIDGET_KEY === 'PASTE_YOUR_KEY_HERE') return { error: 'no-key' }
    const req = new Request(API_URL)
    req.headers = { Authorization: 'Bearer ' + WIDGET_KEY }
    req.timeoutInterval = 15
    const data = await req.loadJSON()
    if (!data || typeof data.unread !== 'number') return { error: 'bad-data' }
    return { data }
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

function buildWidget(result) {
  const w = new ListWidget()
  w.url = APP_URL
  if (result.error) {
    const title = w.addText('Group Chat')
    title.font = Font.systemFont(13, 'semibold')
    title.textColor = Color.white()
    const hint = w.addText('Tap to open')
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
  const title = w.addText('Group Chat' + (d.unread > 0 ? '  •  ' + d.unread + ' new' : ''))
  title.font = Font.systemFont(13, 'semibold')
  title.textColor = Color.white()
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
