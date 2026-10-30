// Team tools for people and AI members (see public/agent-api.md §7):
//   GET    /api/search?q=launch date[&group=…|&with=…|&conversation=group]
//   GET    /api/pins[?group=…|?with=…]          POST/DELETE /api/pins { message_id }
//   POST   /api/polls { question, options: [..], multiple?, to?|group? }
//   POST   /api/polls/vote { poll_id | message_id, option | options: [..] }
//   GET    /api/notes[?kind=task][&group=…|&with=…]
//   POST   /api/notes { kind: note|task|decision, text, to?|group? }
//   PATCH  /api/notes { id, text?, done? }       DELETE /api/notes { id }
//   GET    /api/schedule                         DELETE /api/schedule { id }
//   POST   /api/schedule { text, at, kind?: message|reminder|task, repeat?: daily|weekly, to?|group? }
//   GET    /api/tasks  -> your due AI tasks (and marks them handled)
import { route, auth, body, check, present, conversationFor, presentPoll, userIdFor, HttpError } from '../lib.js'

const args = (req) => ({ ...req.query, ...body(req) })
const where = (query, conv, { pairCols = false } = {}) => {
  if (conv.group_id) return query.eq('group_id', conv.group_id)
  if (pairCols) {
    return conv.pair[0] ? query.is('group_id', null).eq('dm_a', conv.pair[0]).eq('dm_b', conv.pair[1]) : query.is('group_id', null).is('dm_a', null)
  }
  return query
}

const search = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    const q = String(req.query.q ?? '').trim()
    if (!q) throw new HttpError(400, 'q (what to search for) is required')
    const params = { p_query: q, p_limit: Math.min(100, Number(req.query.limit) || 30) }
    if (req.query.group) params.p_group = (await conversationFor(sb, userId, { group: req.query.group })).group_id
    if (req.query.with) params.p_with = await userIdFor(sb, req.query.with)
    if (req.query.conversation === 'group') params.p_main = true
    const rows = check(await sb.rpc('search_messages', params))
    return { query: q, messages: await present(sb, rows) }
  },
})

const pins = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    const q = req.query
    const rows = check(await sb.from('message_pins').select('message_id, pinned_by, pinned_at, messages(*)').order('pinned_at', { ascending: false }).limit(200))
    let msgs = rows.map((r) => r.messages).filter(Boolean)
    if (q.group || q.with || q.conversation === 'group') {
      const conv = await conversationFor(sb, userId, q)
      msgs = msgs.filter((m) =>
        conv.group_id
          ? m.group_id === conv.group_id
          : conv.recipient_id
            ? !m.group_id && [m.user_id, m.recipient_id].sort().join() === conv.pair.join()
            : !m.group_id && !m.recipient_id,
      )
    }
    return { pins: await present(sb, msgs) }
  },
  async POST(req) {
    const { sb } = await auth(req)
    const id = Number(args(req).message_id)
    if (!Number.isInteger(id)) throw new HttpError(400, 'message_id is required')
    const { error } = await sb.from('message_pins').insert({ message_id: id })
    if (error && error.code !== '23505') check({ error })
    return { ok: true, pinned: id }
  },
  async DELETE(req) {
    const { sb } = await auth(req)
    const id = Number(args(req).message_id)
    check(await sb.from('message_pins').delete().eq('message_id', id))
    return { ok: true, unpinned: id }
  },
})

const polls = route({
  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = args(req)
    const question = String(b.question ?? '').trim()
    const options = (Array.isArray(b.options) ? b.options : []).map((o) => String(o).trim()).filter(Boolean)
    if (!question || options.length < 2 || options.length > 10) throw new HttpError(400, 'A poll needs a question and 2-10 options')
    const conv = await conversationFor(sb, userId, b)
    const msg = check(await sb.from('messages').insert({ content: `📊 ${question}`, recipient_id: conv.recipient_id, group_id: conv.group_id }).select().single())
    const { error } = await sb.from('polls').insert({ message_id: msg.id, question, options, multiple: Boolean(b.multiple) })
    if (error) {
      await sb.from('messages').delete().eq('id', msg.id)
      check({ error })
    }
    const [message] = await present(sb, [msg])
    return { message }
  },
})

const vote = route({
  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = args(req)
    let q = sb.from('polls').select('id, message_id, question, options, multiple')
    q = b.poll_id ? q.eq('id', b.poll_id) : q.eq('message_id', Number(b.message_id))
    const poll = check(await q.maybeSingle())
    if (!poll) throw new HttpError(404, 'Poll not found')
    let choice = (Array.isArray(b.options) ? b.options : [b.option]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < poll.options.length)
    if (!choice.length) throw new HttpError(400, `option must be 0-${poll.options.length - 1}`)
    if (!poll.multiple) choice = choice.slice(0, 1)
    check(await sb.from('poll_votes').delete().eq('poll_id', poll.id).eq('user_id', userId))
    check(await sb.from('poll_votes').insert(choice.map((option) => ({ poll_id: poll.id, option }))))
    const full = check(await sb.from('polls').select('id, message_id, question, options, multiple, poll_votes(user_id, option)').eq('id', poll.id).single())
    const names = Object.fromEntries(check(await sb.from('profiles').select('id, username')).map((p) => [p.id, p.username]))
    return { poll: presentPoll(full, names) }
  },
})

const NOTE_KINDS = ['note', 'task', 'decision']
const notes = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    const conv = await conversationFor(sb, userId, req.query)
    let q = where(sb.from('chat_items').select('*').order('created_at'), conv, { pairCols: true })
    if (req.query.kind) q = q.eq('kind', req.query.kind)
    return { items: check(await q) }
  },
  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = args(req)
    if (!NOTE_KINDS.includes(b.kind)) throw new HttpError(400, 'kind must be note, task or decision')
    const conv = await conversationFor(sb, userId, b)
    const item = check(await sb.from('chat_items').insert({ kind: b.kind, text: String(b.text ?? '').trim(), group_id: conv.group_id, dm_a: conv.pair[0], dm_b: conv.pair[1] }).select().single())
    return { item }
  },
  async PATCH(req) {
    const { sb, userId } = await auth(req)
    const b = args(req)
    const patch = { updated_by: userId, updated_at: new Date().toISOString() }
    if (b.text != null) patch.text = String(b.text).trim()
    if (b.done != null) patch.done = Boolean(b.done)
    const item = check(await sb.from('chat_items').update(patch).eq('id', b.id).select().maybeSingle())
    if (!item) throw new HttpError(404, 'Item not found')
    return { item }
  },
  async DELETE(req) {
    const { sb } = await auth(req)
    check(await sb.from('chat_items').delete().eq('id', args(req).id))
    return { ok: true }
  },
})

const schedule = route({
  async GET(req) {
    const { sb } = await auth(req)
    return { scheduled: check(await sb.from('scheduled_messages').select('*').eq('done', false).order('send_at')) }
  },
  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = args(req)
    const at = new Date(b.at ?? b.send_at)
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'at must be a date/time, e.g. 2026-11-01T18:00:00Z')
    const kind = b.kind ?? 'message'
    if (!['message', 'reminder', 'task'].includes(kind)) throw new HttpError(400, 'kind must be message, reminder or task')
    if (b.repeat && !['daily', 'weekly'].includes(b.repeat)) throw new HttpError(400, 'repeat must be daily or weekly')
    const conv = await conversationFor(sb, userId, b)
    const row = check(
      await sb
        .from('scheduled_messages')
        .insert({ content: String(b.text ?? '').trim(), send_at: at.toISOString(), kind, repeat: b.repeat ?? null, recipient_id: conv.recipient_id, group_id: conv.group_id })
        .select()
        .single(),
    )
    return { scheduled: row }
  },
  async DELETE(req) {
    const { sb } = await auth(req)
    check(await sb.from('scheduled_messages').delete().eq('id', args(req).id))
    return { ok: true }
  },
})

// Due AI tasks: returned once, then marked handled.
export async function takeDueTasks(sb) {
  const { data } = await sb.from('scheduled_messages').select('id, content, send_at, repeat, group_id, recipient_id').eq('task_pending', true)
  if (!data?.length) return []
  await sb.from('scheduled_messages').update({ task_pending: false }).in('id', data.map((t) => t.id))
  return data.map((t) => ({ id: t.id, text: t.content, repeat: t.repeat, group_id: t.group_id, recipient_id: t.recipient_id }))
}
const tasks = route({
  async GET(req) {
    const { sb } = await auth(req)
    return { tasks: await takeDueTasks(sb) }
  },
})

export default { search, pins, polls, vote, notes, schedule, tasks }
