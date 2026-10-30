// Fake backend for capturing promo screens: no real data, no network.
const fs = require('fs')
const path = require('path')
const ME = '11111111-1111-1111-1111-111111111111', ADAM = '22222222-2222-2222-2222-222222222222', MUD = '33333333-3333-3333-3333-333333333333', ALI = '44444444-4444-4444-4444-444444444444'
const GROUP = 'aaaaaaaa-0000-0000-0000-000000000001'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: ME, exp, role: 'authenticated' })}.x`
const t = (m) => new Date(Date.now() - m * 60000).toISOString()
const POSTER = fs.readFileSync(path.join(__dirname, 'poster.jpg'))

function data() {
  const m = []
  let id = 100
  const add = (o, minsAgo) => m.push({ id: id++, recipient_id: null, group_id: null, created_at: t(minsAgo), ...o })
  // main group chat (short, so nothing scrolls between states)
  add({ user_id: MUD, content: 'Morning team ☀️ Launch day!' }, 42)
  add({ user_id: ADAM, content: 'Announcement is drafted and scheduled for 5 PM 📣' }, 41)
  add({ user_id: ALI, content: 'Checklist: 12 of 14 done ✅' }, 40)
  add({ user_id: ME, content: 'Amazing work. Can we go live at 5?' }, 3)
  // private chat with Adam
  add({ user_id: ME, recipient_id: ADAM, content: 'Adam, can you record the intro for the launch video?' }, 30)
  add({ user_id: ADAM, recipient_id: ADAM === ME ? null : ME, attachment_path: 'adam/intro.m4a', attachment_name: 'voice-note.m4a', attachment_type: 'audio/mp4', attachment_size: 120000, attachment_duration: 18 }, 29)
  add({ user_id: ME, recipient_id: ADAM, attachment_path: 'me/reply.m4a', attachment_name: 'voice-note.m4a', attachment_type: 'audio/mp4', attachment_size: 60000, attachment_duration: 7 }, 28)
  add({ user_id: ADAM, recipient_id: ME, content: 'Here is the poster too 🎨', attachment_path: 'adam/poster.jpg', attachment_name: 'poster.jpg', attachment_type: 'image/jpeg', attachment_size: 66474 }, 27)
  // other private chats
  add({ user_id: ALI, recipient_id: ME, content: 'Sent the final numbers. Want a summary?' }, 12)
  add({ user_id: MUD, recipient_id: ME, content: 'See you at 5 🎉' }, 90)
  // named group
  add({ user_id: ME, group_id: GROUP, content: 'Welcome to the launch team!' }, 20)
  add({ user_id: ALI, group_id: GROUP, content: 'Ready when you are 🚀' }, 6)
  return m
}

async function setup(page, opts = {}) {
  const state = { msgs: data(), reads: opts.reads ?? [], reactions: opts.reactions ?? [], groups: [], members: [], ws: null, t: opts.t ?? {} }
  if (opts.withGroup !== false) {
    state.groups.push({ id: GROUP, name: 'Launch Team', created_by: ME, created_at: t(21) })
    for (const u of [ME, ADAM, ALI, MUD]) state.members.push({ group_id: GROUP, user_id: u, added_at: t(21) })
  }
  await page.routeWebSocket(/realtime\/v1\/websocket/, (sock) => {
    state.ws = sock
    sock.onMessage((raw) => {
      if (typeof raw !== 'string') return
      let msg; try { msg = JSON.parse(raw) } catch { return }
      const [jr, ref, topic, event] = msg
      if (event === 'phx_join' && topic === 'realtime:typing') state.typingTopic = topic
      if (event === 'phx_join' && topic === 'realtime:group-chat') state.chatTopic = topic
      if (ref) sock.send(JSON.stringify([jr, ref, event === 'heartbeat' ? 'phoenix' : topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }]))
    })
  })
  await page.route(/supabase\.co/, async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method(), sp = url.searchParams
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) })
    if (p.startsWith('/auth/v1/token')) return json({ access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r', user: { id: ME, aud: 'authenticated' } })
    if (p.startsWith('/auth/v1/user')) return json({ id: ME, aud: 'authenticated' })
    if (p.startsWith('/storage/v1/object/sign/') && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}')
      return json((body.paths ?? []).map((x) => ({ path: x, signedURL: `/object/sign/chat-files/${x}?token=t`, error: null })))
    }
    if (p.startsWith('/storage/v1/object/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
    if (p === '/rest/v1/profiles') {
      const now = new Date().toISOString()
      const all = [{ id: ME, username: 'mubarak' }, { id: ADAM, username: 'adam', is_ai: true, last_seen_at: now }, { id: MUD, username: 'mudassir', last_seen_at: now }, { id: ALI, username: 'ali', is_ai: true, last_seen_at: now }]
      return sp.get('id') ? json(all.filter((x) => 'eq.' + x.id === sp.get('id'))) : json(all)
    }
    if (p === '/rest/v1/message_reads' && method === 'GET') return json(state.reads)
    if (p === '/rest/v1/rpc/search_messages') {
      const b = JSON.parse(req.postData() || '{}'); const words = b.p_query.toLowerCase().split(/\s+/).filter(Boolean)
      return json(state.msgs.filter((m) => m.content && words.every((w) => m.content.toLowerCase().includes(w))).sort((a, b) => b.id - a.id))
    }
    if (p === '/rest/v1/rpc/add_poll_option') return json([])
    const TOOL = { polls: 1, poll_votes: 1, message_pins: 1, chat_items: 1, scheduled_messages: 1 }
    const tname = p.slice(9)
    if (p.startsWith('/rest/v1/') && TOOL[tname]) {
      const rows = (state.t[tname] ??= [])
      if (method === 'GET') {
        let out = rows
        if (tname === 'message_pins') out = rows.map((r) => ({ ...r, messages: state.msgs.find((m) => m.id === r.message_id) }))
        if (tname === 'polls') out = rows.map((r) => ({ ...r, poll_votes: (state.t.poll_votes ?? []).filter((v) => v.poll_id === r.id) }))
        return json(out)
      }
      if (method === 'POST') {
        const b = JSON.parse(req.postData()); const items = (Array.isArray(b) ? b : [b]).map((r) => ({ id: tname + rows.length + 'x', user_id: ME, created_by: ME, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), done: false, ...r }))
        rows.push(...items); return json((req.headers()['accept'] || '').includes('vnd.pgrst.object') ? items[0] : items, 201)
      }
      if (method === 'DELETE') {
        const f = [...sp.entries()].filter(([k]) => k !== 'select').map(([k, v]) => [k, v.replace(/^eq\./, '')])
        state.t[tname] = rows.filter((r) => !f.every(([k, v]) => String(r[k]) === v)); return json([])
      }
      return json([])
    }
    if (p === '/rest/v1/reactions' && method === 'GET') return json(state.reactions)
    if (p === '/rest/v1/chat_groups' && method === 'GET') return json(state.groups)
    if (p === '/rest/v1/chat_group_members' && method === 'GET') return json(state.members)
    if (p === '/rest/v1/messages' && method === 'GET') {
      let out = state.msgs
      for (const [k, v] of sp.entries()) {
        if (k === 'id' && v.startsWith('gt.')) out = out.filter((m) => m.id > Number(v.slice(3)))
        if (k === 'id' && v.startsWith('lt.')) out = out.filter((m) => m.id < Number(v.slice(3)))
        if (k === 'id' && v.startsWith('in.')) { const ids = v.slice(4, -1).split(',').map(Number); out = out.filter((m) => ids.includes(m.id)) }
        if (k === 'recipient_id' && v === 'is.null') out = out.filter((m) => m.recipient_id == null)
        if (k === 'recipient_id' && v === 'not.is.null') out = out.filter((m) => m.recipient_id != null)
        if (k === 'group_id' && v === 'is.null') out = out.filter((m) => !m.group_id)
        if (k === 'group_id' && v.startsWith('eq.')) out = out.filter((m) => m.group_id === v.slice(3))
        if (k === 'or') {
          const pairs = [...v.matchAll(/and\(user_id\.eq\.([\w-]+),recipient_id\.eq\.([\w-]+)\)/g)].map((x) => [x[1], x[2]])
          if (pairs.length) out = out.filter((m) => pairs.some(([a, b]) => m.user_id === a && m.recipient_id === b))
          else {
            const ors = [...v.matchAll(/(user_id|recipient_id)\.eq\.([\w-]+)/g)]
            if (ors.length) out = out.filter((m) => ors.some(([, f, x]) => m[f] === x))
          }
        }
      }
      out = [...out].sort((a, b) => ((sp.get('order') || '').includes('desc') ? b.id - a.id : a.id - b.id))
      if (sp.get('limit')) out = out.slice(0, Number(sp.get('limit')))
      if ((req.headers()['accept'] || '').includes('vnd.pgrst.object')) return json(out[0] ?? null)
      return json(sp.get('select') === 'id' ? out.map((m) => ({ id: m.id })) : out)
    }
    if (method === 'GET') return json([])
    if (p === '/rest/v1/messages' && method === 'POST') {
      const body = JSON.parse(req.postData())
      const row = { id: Math.max(...state.msgs.map((m) => m.id)) + 1, user_id: ME, recipient_id: null, group_id: null, created_at: new Date().toISOString(), ...body }
      state.msgs.push(row)
      return json((req.headers()['accept'] || '').includes('vnd.pgrst.object') ? row : [row], 201)
    }
    return route.fulfill({ status: 201, body: '' })
  })
  return state
}

function push(state, m) {
  state.msgs.push(m)
  state.ws?.send(JSON.stringify([null, null, state.chatTopic, 'postgres_changes', { data: { type: 'INSERT', schema: 'public', table: 'messages', record: m, commit_timestamp: m.created_at, columns: [], errors: null }, ids: [] }]))
}
function typing(state, user_id, to, on = true) {
  state.ws?.send(JSON.stringify([null, null, state.typingTopic, 'broadcast', { type: 'broadcast', event: 'typing', payload: { user_id, to, typing: on } }]))
}

async function login(page, url = 'http://localhost:4185') {
  await page.goto(url)
  await page.fill('input[autocomplete=username]', 'mubarak')
  await page.fill('input[type=password]', 'pw')
  await page.click('button.primary')
  await page.waitForSelector('.convo')
}
function rt(state, table, record, type = 'INSERT') {
  state.ws?.send(JSON.stringify([null, null, state.chatTopic, 'postgres_changes', { data: { type, schema: 'public', table, record, commit_timestamp: new Date().toISOString(), columns: [], errors: null }, ids: [] }]))
}
module.exports = { rt, setup, push, typing, login, ME, ADAM, MUD, ALI, GROUP, t }
