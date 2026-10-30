// Team tools for people and AI members (see public/agent-api.md §7):
//   GET    /api/search?q=launch date[&group=…|&with=…|&conversation=group]
//   GET    /api/pins[?group=…|?with=…]          POST/DELETE /api/pins { message_id }
//   POST   /api/polls { question, options: [..], multiple?, to?|group? }
//   POST   /api/polls/vote { poll_id | message_id, option | options: [..] }
//   POST   /api/polls/choice { poll_id | message_id, text }   (Add Choice)
//   GET    /api/notes[?kind=task][&group=…|&with=…]
//   POST   /api/notes { kind: note|task|decision, text, to?|group? }
//   PATCH  /api/notes { id, text?, done? }       DELETE /api/notes { id }
//   GET    /api/schedule                         DELETE /api/schedule { id }
//   POST   /api/schedule { text, at, kind?: message|reminder|task, repeat?: daily|weekly, to?|group? }
//   GET    /api/tasks  -> your due AI tasks (and marks them handled)
//   POST   /api/assignments { to, text, due?, group? }  -> give someone (an AI) a task
//   GET    /api/assignments                -> tasks given to you that are still open
//   POST   /api/assignments/update { task_id, status?, note?, result?, file?|file_url? }
import { route, auth, body, check, present, conversationFor, presentPoll, presentTask, userIdFor, HttpError, BUCKET } from '../lib.js'
import { readFile } from './messages.js'

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
    // The question is the comment shown under the choices (optional, like iMessage).
    const question = String(b.question ?? b.comment ?? '').trim() || 'Poll'
    const options = (Array.isArray(b.options) ? b.options : []).map((o) => String(o).trim()).filter(Boolean)
    if (options.length < 2 || options.length > 10) throw new HttpError(400, 'A poll needs 2-10 options')
    const conv = await conversationFor(sb, userId, b)
    const summary = question === 'Poll' ? `Poll: ${options.join(', ')}` : question
    const msg = check(await sb.from('messages').insert({ content: `📊 ${summary}`.slice(0, 4000), recipient_id: conv.recipient_id, group_id: conv.group_id }).select().single())
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

const choice = route({
  async POST(req) {
    const { sb } = await auth(req)
    const b = args(req)
    let q = sb.from('polls').select('id')
    q = b.poll_id ? q.eq('id', b.poll_id) : q.eq('message_id', Number(b.message_id))
    const poll = check(await q.maybeSingle())
    if (!poll) throw new HttpError(404, 'Poll not found')
    const options = check(await sb.rpc('add_poll_option', { p_poll: poll.id, p_text: String(b.text ?? '') }))
    return { poll_id: poll.id, options }
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

const TASK_STATUSES = ['assigned', 'working', 'done', 'failed', 'cancelled']
const names = async (sb) => Object.fromEntries(check(await sb.from('profiles').select('id, username')).map((p) => [p.id, p.username]))

// Open tasks given to you, oldest first; marks them delivered.
export async function takeAssignedTasks(sb, userId, { all = false } = {}) {
  let q = sb.from('ai_tasks').select('*, ai_task_updates(status, note, attachment_name, attachment_type, created_at, user_id)').eq('assignee', userId).in('status', ['assigned', 'working']).order('created_at')
  if (!all) q = q.is('delivered_at', null)
  const { data } = await q
  if (!data?.length) return []
  const fresh = data.filter((t) => !t.delivered_at).map((t) => t.id)
  if (fresh.length) await sb.from('ai_tasks').update({ delivered_at: new Date().toISOString() }).in('id', fresh)
  const n = await names(sb)
  return data.map((t) => presentTask(t, n))
}

const assignments = route({
  async GET(req) {
    const { sb, userId } = await auth(req)
    return { tasks: await takeAssignedTasks(sb, userId, { all: true }) }
  },
  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = args(req)
    const title = String(b.text ?? b.title ?? '').trim()
    if (!title) throw new HttpError(400, 'text (what to do) is required')
    if (!b.to && !b.assignee) throw new HttpError(400, 'to (who should do it) is required')
    const assignee = await userIdFor(sb, b.assignee ?? b.to)
    // The card goes in a named group if given, else the private chat with the assignee.
    const conv = b.group ? await conversationFor(sb, userId, { group: b.group }) : { group_id: null, recipient_id: assignee === userId ? null : assignee }
    const due = b.due ? new Date(b.due) : null
    if (due && Number.isNaN(due.getTime())) throw new HttpError(400, 'due must be a date/time')
    const msg = check(await sb.from('messages').insert({ content: `🗂 Task: ${title}`.slice(0, 4000), recipient_id: conv.recipient_id, group_id: conv.group_id }).select().single())
    const { error } = await sb.from('ai_tasks').insert({ message_id: msg.id, assignee, title, due_at: due?.toISOString() ?? null })
    if (error) {
      await sb.from('messages').delete().eq('id', msg.id)
      check({ error })
    }
    const [message] = await present(sb, [msg])
    return { message }
  },
})

const assignmentUpdate = route({
  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = args(req)
    const task = check(await sb.from('ai_tasks').select('*').eq('id', b.task_id).maybeSingle())
    if (!task) throw new HttpError(404, 'Task not found')
    if (task.assignee !== userId && task.created_by !== userId) throw new HttpError(403, 'Only the assignee or the creator can update this task')
    if (b.status && !TASK_STATUSES.includes(b.status)) throw new HttpError(400, `status must be one of ${TASK_STATUSES.join(', ')}`)
    const note = b.note != null ? String(b.note).trim().slice(0, 4000) : null
    const result = b.result != null ? String(b.result).trim().slice(0, 20000) : null

    let file = await readFile(b)
    let attachment = {}
    if (file) {
      const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file'
      const path = `${userId}/${Date.now()}-task-${safe}`
      const { error } = await sb.storage.from(BUCKET).upload(path, file.bytes, { contentType: file.type })
      if (error) throw new HttpError(400, `Upload failed: ${error.message}`)
      attachment = { attachment_path: path, attachment_name: file.name, attachment_type: file.type }
    }
    check(await sb.from('ai_task_updates').insert({ task_id: task.id, status: b.status ?? null, note: note ?? (result ? result.slice(0, 4000) : null), ...attachment }))
    const patch = { updated_at: new Date().toISOString() }
    if (b.status) patch.status = b.status
    if (note) patch.progress = note.slice(0, 1000)
    if (result) patch.result = result
    check(await sb.from('ai_tasks').update(patch).eq('id', task.id))

    // Finishing (or failing) posts a reply under the card, so everyone is notified.
    if (b.status === 'done' || b.status === 'failed') {
      const card = check(await sb.from('messages').select('recipient_id, group_id, user_id').eq('id', task.message_id).single())
      const recipient = card.recipient_id ? (card.user_id === userId ? card.recipient_id : card.user_id) : null
      const text = `${b.status === 'done' ? '✅ Done' : '⚠️ Could not finish'}: ${result || note || task.title}`.slice(0, 4000)
      await sb.from('messages').insert({ content: text, reply_to_id: task.message_id, recipient_id: recipient, group_id: card.group_id, ...attachment })
    }
    const full = check(await sb.from('ai_tasks').select('*, ai_task_updates(status, note, attachment_name, attachment_type, created_at, user_id)').eq('id', task.id).single())
    return { task: presentTask(full, await names(sb)) }
  },
})

export default { search, pins, polls, vote, choice, notes, schedule, tasks, assignments, assignmentUpdate }
