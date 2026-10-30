// Project dashboard routes (migration 0019, already live in Supabase).
//   GET    /api/projects                        projects visible to the caller
//   POST   /api/projects { name }               create, owner_id = caller
//   GET    /api/projects/<id>                   one project's dashboard data
//   PATCH  /api/projects/<id> { name }          owner only
//   DELETE /api/projects/<id>                   owner only (trade rows cascade)
//   GET    /api/projects/<id>/queue|trades|references|notes|sync-log
//   POST   /api/projects/<id>/queue|trades|references|notes|sync-log
//   PATCH  /api/projects/<id>/queue|trades/<row id>
//   DELETE /api/projects/<id>/queue|trades|references|notes|sync-log/<row id>
//
// Auth and access follow the existing pattern in server/lib.js exactly:
// every request runs as the caller (API key or Supabase access token) under
// the normal row-level security rules, via the caller's Supabase session.
// No service-role client is used for project data, and no RLS rule is
// weakened here. The 0019 policies are the gate: a project row (and its
// queue, trade, reference, note and sync-log rows) is visible only to the
// project owner, the group owner (username 'mubarak'), or an AI member
// ('adam' or 'ali'); other members get no rows, which surfaces here as
// 404, never as another member's data. Deletes are owner-only by policy.
// Reads and writes below also fetch the project first, so a forbidden
// project fails as 404 before any child row is touched.

import { route, auth, body, check, HttpError } from '../lib.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const QUEUE_STATUSES = ['queued', 'extracted', 'finished', 'matched', 'new', 'failed', 'needs_review']
const TRADE_STAGES = ['extracted', 'finished', 'matched', 'new']
const COLLECTIONS = ['queue', 'trades', 'references', 'notes', 'sync-log']
const TABLES = { queue: 'trade_queue', trades: 'trades', references: 'trade_references', notes: 'trade_notes', 'sync-log': 'trade_sync_log' }
// Fields a caller may set. Ids, owner_id, project_id and timestamps are
// never taken from the request body; project_id comes from the URL and
// owner_id from the caller's session.
const WRITABLE = {
  queue: ['message_id', 'sender', 'subject', 'body', 'status', 'attempts', 'last_error', 'credit_used'],
  trades: ['queue_id', 'contract_ref', 'buyer', 'seller', 'commodity', 'quantity', 'disport', 'lifecycle_stage', 'sub_stage', 'action_owner', 'deadline', 'fingerprint', 'stage'],
  references: ['shadow_ref', 'live_refs', 'external_refs', 'fingerprint'],
  notes: ['trade_id', 'subject', 'summary', 'priority', 'action_required', 'message_id'],
  'sync-log': ['trade_id', 'target', 'success', 'failure_reason'],
}
const PATCHABLE = {
  queue: ['sender', 'subject', 'body', 'status', 'attempts', 'last_error', 'credit_used'],
  trades: ['queue_id', 'contract_ref', 'buyer', 'seller', 'commodity', 'quantity', 'disport', 'lifecycle_stage', 'sub_stage', 'action_owner', 'deadline', 'fingerprint', 'stage'],
}

function projectId(req) {
  const id = String(req.query.id ?? req.query.projectId ?? '')
  if (!UUID_RE.test(id)) throw new HttpError(400, 'project id must be a UUID')
  return id
}

function collection(req) {
  const kind = String(req.query.kind ?? '')
  if (!COLLECTIONS.includes(kind)) throw new HttpError(404, `No project collection "${kind}"`)
  return kind
}

function rowId(req) {
  const id = Number(req.query.rowId)
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'row id must be a positive integer')
  return id
}

function clean(b, allowed) {
  const out = {}
  for (const key of allowed) {
    if (b[key] === undefined) continue
    const v = b[key]
    out[key] = typeof v === 'string' ? v.trim() || null : v
  }
  return out
}

// The project row the caller can see, or 404. RLS does the access check:
// a non-member project simply does not come back for this caller.
async function visibleProject(sb, id) {
  const row = check(await sb.from('projects').select('id, owner_id, name, created_at').eq('id', id).maybeSingle())
  if (!row) throw new HttpError(404, 'Project not found or not visible to you')
  return row
}

// A queue/trade row inside this project, or 404, used to validate
// queue_id / trade_id references on writes.
async function childInProject(sb, table, id, pid) {
  if (id == null) return
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${table} id must be a positive integer`)
  const row = check(await sb.from(table).select('id').eq('id', n).eq('project_id', pid).maybeSingle())
  if (!row) throw new HttpError(404, `${table} row ${n} not found in this project`)
}

const projects = route({
  async GET(req) {
    const { sb } = await auth(req)
    const rows = check(await sb.from('projects').select('id, owner_id, name, created_at').order('created_at'))
    return { projects: rows }
  },

  async POST(req) {
    const { sb, userId } = await auth(req)
    const b = body(req)
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) throw new HttpError(400, 'name is required')
    if (name.length > 200) throw new HttpError(400, 'name must be 200 characters or fewer')
    const row = check(await sb.from('projects').insert({ owner_id: userId, name }).select('id, owner_id, name, created_at').single())
    return { project: row }
  },
})

const project = route({
  async GET(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const proj = await visibleProject(sb, id)
    const [queue, trades, references, notes, syncLog] = await Promise.all([
      check(await sb.from('trade_queue').select('*').eq('project_id', id).order('id').limit(200)),
      check(await sb.from('trades').select('*').eq('project_id', id).order('id').limit(200)),
      check(await sb.from('trade_references').select('*').eq('project_id', id).order('id').limit(200)),
      check(await sb.from('trade_notes').select('*').eq('project_id', id).order('created_at', { ascending: false }).limit(200)),
      check(await sb.from('trade_sync_log').select('*').eq('project_id', id).order('created_at', { ascending: false }).limit(200)),
    ])
    return { project: proj, queue, trades, references, notes, sync_log: syncLog }
  },

  async PATCH(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    await visibleProject(sb, id)
    const name = typeof body(req).name === 'string' ? body(req).name.trim() : ''
    if (!name) throw new HttpError(400, 'name is required')
    if (name.length > 200) throw new HttpError(400, 'name must be 200 characters or fewer')
    // Owner-only by the 0019 update policy; a non-owner update returns no
    // row, which is reported as 404, not as another member's project.
    const row = check(await sb.from('projects').update({ name }).eq('id', id).select('id, owner_id, name, created_at').maybeSingle())
    if (!row) throw new HttpError(404, 'Project not found, not visible to you, or not yours to update')
    return { project: row }
  },

  async DELETE(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    await visibleProject(sb, id)
    const row = check(await sb.from('projects').delete().eq('id', id).select('id').maybeSingle())
    if (!row) throw new HttpError(404, 'Project not found, not visible to you, or not yours to delete')
    return { ok: true, deleted: id }
  },
})

const subcollection = route({
  async GET(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const kind = collection(req)
    await visibleProject(sb, id)
    const rows = check(await sb.from(TABLES[kind]).select('*').eq('project_id', id).order('id').limit(200))
    return { project_id: id, [kind === 'sync-log' ? 'sync_log' : kind]: rows }
  },

  async POST(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const kind = collection(req)
    await visibleProject(sb, id)
    const b = body(req)
    const row = clean(b, WRITABLE[kind])
    if (kind === 'queue') {
      if (!row.message_id) throw new HttpError(400, 'message_id is required for a queue item')
      row.status = row.status ?? 'queued'
      if (!QUEUE_STATUSES.includes(row.status)) throw new HttpError(400, `status must be one of: ${QUEUE_STATUSES.join(', ')}`)
    }
    if (kind === 'trades') {
      row.stage = row.stage ?? 'extracted'
      if (!TRADE_STAGES.includes(row.stage)) throw new HttpError(400, `stage must be one of: ${TRADE_STAGES.join(', ')}`)
      await childInProject(sb, 'trade_queue', row.queue_id, id)
    }
    if (kind === 'notes' || kind === 'sync-log') await childInProject(sb, 'trades', row.trade_id, id)
    if (kind === 'sync-log') {
      row.target = row.target ?? 'google_sheet'
      row.success = row.success ?? false
    }
    // RLS insert policies are the backstop: a caller who is not a project
    // member gets 403 here even if the project check above were bypassed.
    const saved = check(await sb.from(TABLES[kind]).insert({ ...row, project_id: id }).select().single())
    const singular = { queue: 'queue_item', trades: 'trade', references: 'reference', notes: 'note', 'sync-log': 'sync_log' }[kind]
    return { [singular]: saved }
  },
})

const item = route({
  async PATCH(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const kind = collection(req)
    if (!PATCHABLE[kind]) throw new HttpError(405, `Only queue and trade rows can be updated this way`)
    const rid = rowId(req)
    await visibleProject(sb, id)
    const b = body(req)
    const row = clean(b, PATCHABLE[kind])
    if (row.status !== undefined && !QUEUE_STATUSES.includes(row.status)) throw new HttpError(400, `status must be one of: ${QUEUE_STATUSES.join(', ')}`)
    if (row.stage !== undefined && !TRADE_STAGES.includes(row.stage)) throw new HttpError(400, `stage must be one of: ${TRADE_STAGES.join(', ')}`)
    if (row.queue_id !== undefined) await childInProject(sb, 'trade_queue', row.queue_id, id)
    if (Object.keys(row).length === 0) throw new HttpError(400, 'Nothing to update')
    const saved = check(await sb.from(TABLES[kind]).update(row).eq('id', rid).eq('project_id', id).select().maybeSingle())
    if (!saved) throw new HttpError(404, 'Row not found in this project or not visible to you')
    return { [kind === 'queue' ? 'queue_item' : 'trade']: saved }
  },

  async DELETE(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const kind = collection(req)
    const rid = rowId(req)
    await visibleProject(sb, id)
    // Owner-only by the 0019 delete policies; a non-owner delete returns
    // no row and is reported as 404.
    const row = check(await sb.from(TABLES[kind]).delete().eq('id', rid).eq('project_id', id).select('id').maybeSingle())
    if (!row) throw new HttpError(404, 'Row not found in this project, not visible to you, or not yours to delete')
    return { ok: true, deleted: rid }
  },
})

export { projects, project, subcollection, item }
