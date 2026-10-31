// Project dashboard routes (migration 0019, already live in Supabase).
//   GET    /api/projects                        projects visible to the caller
//   POST   /api/projects { name }               create, owner_id = caller
//   GET    /api/projects/<id>                   one project's dashboard data:
//                                                project row, exact counts,
//                                                stage counts, sync summary,
//                                                emptyColumns, databaseColumns,
//                                                latest 20 slim trades and
//                                                latest 20 notes only. It
//                                                does NOT return 200 full
//                                                rows of every collection:
//                                                full tables are paged
//                                                through the subcollection
//                                                GET below, 50 rows at a
//                                                time, so opening a
//                                                dashboard is fast.
//   PATCH  /api/projects/<id> { name }          owner only
//   DELETE /api/projects/<id>                   owner only (trade rows cascade)
//   GET    /api/projects/<id>/queue|trades|references|notes|sync-log
//                                                paged, limit/offset, with
//                                                a total count; ?slim=1 on
//                                                trades returns slim fields
//                                                only, no full_data
//   GET    /api/projects/<id>/<kind>/<row id>  one row, full, for detail
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

import { randomUUID } from 'node:crypto'
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
const SLIM_TRADE_FIELDS = 'id, project_id, queue_id, contract_ref, buyer, seller, commodity, quantity, disport, stage, lifecycle_stage, created_at'
const TRADESDB_SHEET_COLUMNS = ["timestamp", "Mercancia_Contract_ref", "trade_date", "purchase_or_sale", "total_quantity", "quantity_unit", "commodity_name", "origin", "incoterm", "destination_port", "shipment_window", "unit_price", "currency", "price_per_unit", "seller_name", "seller_address", "seller_contact", "seller_email", "seller_phone", "seller_signatory", "buyer_name", "buyer_address", "buyer_contact", "buyer_email", "buyer_phone", "buyer_signatory", "direct_business", "broker_name", "broker_address", "broker_contact", "broker_email", "broker_phone", "commission", "crop_year", "moisture_max", "protein_min", "oil_min", "purity_min", "admixture_max", "fibre_max", "ash_max", "starch_min", "aflatoxin_limit", "nut_count", "outturn_kor", "weevilled_max", "natural_variation", "physical_condition", "cleaning_method", "tolerance", "tolerance_type", "cargo_type", "container_type", "total_containers", "load_per_container", "partial_shipment", "transshipment", "free_time_dest", "shipment_advice", "insurance", "demurrage_free_time", "packing_type", "packing_size", "shipping_marks", "tagging_labels", "weight_quality_basis", "inspection_agency", "inspection_paid_by", "silica_gel", "fumigation_type", "container_lining", "inland_haulage", "thc_status", "payment_terms", "key_deadline", "beneficiary_name", "bank_name", "account_number", "swift_bic", "gst_number", "pan_number", "iec_code", "fssai_number", "exim_code", "arbitration_law", "import_permit_noc", "doc_instructions", "required_documents", "addendum_notes", "raw_message", "last_update", "contract_issuer", "additional_information", "trader_name", "product_category", "Parent_Folder_URL", "authorized_signatory", "back_to_back_source_ref", "column_98", "contract_no", "direction", "Folder_Banking_URL", "Folder_Contacts_URL", "Folder_Docs_URL", "Folder_Logistics_URL", "Folder_Packing_URL", "Folder_Specs_URL", "Has_notes", "mercancia_ref", "modification_notes", "Notes", "parent_reference", "Sender_Email", "trade_status", "trade_type", "WhatsApp_number"]
const PATCHABLE = {
  queue: ['sender', 'subject', 'body', 'status', 'attempts', 'last_error', 'credit_used'],
  // full_data is the full TradesDB row for this trade (migration 0020,
  // draft only until approved and applied). It is updated through this
  // existing PATCH route only, never through POST, and only as a plain
  // JSON object; see the validation in item.PATCH below. Reads need no
  // change: the dashboard and subcollection GETs already select('*').
  trades: ['queue_id', 'contract_ref', 'buyer', 'seller', 'commodity', 'quantity', 'disport', 'lifecycle_stage', 'sub_stage', 'action_owner', 'deadline', 'fingerprint', 'stage', 'full_data'],
  notes: ['trade_id', 'subject', 'summary', 'priority', 'action_required', 'message_id'],
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

// Exact row count under RLS, no rows returned. check() discards the
// count, so this reads the response directly and throws on error.
async function countExact(sb, table, id) {
  const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true }).eq('project_id', id)
  if (error) throw new HttpError(500, error.message)
  return count ?? 0
}
const isEmptyValue = (v) =>
  v === null || v === undefined || (typeof v === 'string' && (v.trim() === '' || v.trim() === '—' || v.trim() === '-')) || (Array.isArray(v) && v.length === 0)

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
    // Do NOT use insert().select() here: the projects SELECT policy calls
    // can_access_project(), which queries the projects table itself, and in
    // an INSERT ... RETURNING query it cannot yet see the row just created,
    // so it fails with an RLS error even though the INSERT itself passes
    // (proven in Supabase: insert without returning succeeds, with
    // returning fails). Insert with a client-generated id, then fetch the
    // row in a separate query, which sees it normally.
    const id = randomUUID()
    check(await sb.from('projects').insert({ id, owner_id: userId, name }))
    const row = check(await sb.from('projects').select('id, owner_id, name, created_at').eq('id', id).single())
    return { project: row }
  },
})

const project = route({
  // Fast dashboard: counts, stage counts, sync summary, empty
  // columns and latest slim rows only. No 200-row full collections:
  // the old shape returned 200 trades (each with a 116-field
  // full_data), 200 notes, 200 references, queue and sync log in
  // one payload, then every tab re-loaded its full collection.
  // Callers that need a full table must page the subcollection GET.
  // Shape: { project, counts, stageCounts, pendingSyncIds,
  // syncedIds, emptyColumns, databaseColumns, hasFullData,
  // latestTrades, latestNotes }. There is deliberately no queue,
  // references or sync_log list here, and no trades/notes full
  // list: latestTrades/latestNotes are the latest 20 only.
  async GET(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const proj = await visibleProject(sb, id)
    const [queueCount, tradesCount, referencesCount, notesCount, syncLogCount, tradeStages, queueRows, syncRows, fullDataRows, latestTrades, latestNotes] = await Promise.all([
      countExact(sb, 'trade_queue', id),
      countExact(sb, 'trades', id),
      countExact(sb, 'trade_references', id),
      countExact(sb, 'trade_notes', id),
      countExact(sb, 'trade_sync_log', id),
      check(await sb.from('trades').select('id, queue_id, stage').eq('project_id', id).order('id')),
      check(await sb.from('trade_queue').select('id, status').eq('project_id', id).order('id')),
      check(await sb.from('trade_sync_log').select('trade_id, target, success, created_at').eq('project_id', id).order('created_at')),
      // One scan, full_data only, no other collection: this is what
      // emptyColumns and databaseColumns are computed from, so the
      // browser never needs full_data to know which columns are empty.
      check(await sb.from('trades').select('full_data').eq('project_id', id).order('id')),
      check(await sb.from('trades').select(SLIM_TRADE_FIELDS).eq('project_id', id).order('id', { ascending: false }).limit(20)),
      check(await sb.from('trade_notes').select('*').eq('project_id', id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(20)),
    ])
    const counts = { queue: queueCount, trades: tradesCount, references: referencesCount, notes: notesCount, sync_log: syncLogCount }
    const linkedQueueIds = new Set(tradeStages.map((t) => t.queue_id).filter((v) => v != null))
    const stageCounts = { extracted: 0, finished: 0, matched: 0, new: 0 }
    for (const t of tradeStages) if (stageCounts[t.stage] !== undefined) stageCounts[t.stage] += 1
    for (const q of queueRows) {
      if (stageCounts[q.status] !== undefined && !linkedQueueIds.has(q.id)) stageCounts[q.status] += 1
    }
    const syncedIds = [...new Set(syncRows.filter((r) => r.target === 'google_sheet' && r.success).map((r) => r.trade_id))]
    const pendingSyncIds = [...new Set(syncRows.filter((r) => r.target === 'sync_request' && !syncRows.some((c) => c.target === 'google_sheet' && c.trade_id === r.trade_id && c.created_at >= r.created_at)).map((r) => r.trade_id))]
    const fullRows = fullDataRows.map((r) => r.full_data).filter((v) => v && typeof v === 'object' && !Array.isArray(v))
    const hasFullData = fullRows.length > 0
    const databaseColumns = []
    if (hasFullData) {
      for (const col of TRADESDB_SHEET_COLUMNS) {
        if (fullRows.some((fd) => Object.prototype.hasOwnProperty.call(fd, col))) databaseColumns.push(col)
      }
      for (const fd of fullRows) {
        for (const col of Object.keys(fd)) if (!databaseColumns.includes(col)) databaseColumns.push(col)
      }
    }
    const emptyColumns = hasFullData
      ? TRADESDB_SHEET_COLUMNS.filter((col) => fullRows.every((fd) => isEmptyValue(fd[col])))
      : []
    return { project: proj, counts, stageCounts, pendingSyncIds, syncedIds, emptyColumns, databaseColumns, hasFullData, latestTrades, latestNotes }
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
    // Pagination is backward compatible: the default is exactly the old
    // behaviour (first 200 rows by id). It exists because the seeded
    // trades are 206 rows, so a single uncapped page cannot return them
    // all, and the backfill must see every trade id in insertion order.
    // limit is clamped to 1..200, offset must be >= 0; invalid values 400.
    const rawLimit = req.query.limit
    const rawOffset = req.query.offset
    const limit = rawLimit === undefined ? 200 : Number(rawLimit)
    const offset = rawOffset === undefined ? 0 : Number(rawOffset)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'limit must be an integer between 1 and 200')
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset must be an integer of 0 or more')
    // ?slim=1 on trades returns slim fields only, no full_data, so a
    // list page stays small. has_full_data is computed from the ids
    // of trades with a non-null full_data (ids only, cheap), not by
    // selecting full_data itself. Other collections ignore slim.
    const slim = req.query.slim === '1' && kind === 'trades'
    const [rows, total, fullIds] = await Promise.all([
      check(await sb.from(TABLES[kind]).select(slim ? SLIM_TRADE_FIELDS : '*').eq('project_id', id).order('id').range(offset, offset + limit - 1)),
      countExact(sb, TABLES[kind], id),
      slim ? check(await sb.from('trades').select('id').eq('project_id', id).not('full_data', 'is', null)) : [],
    ])
    const fullIdSet = new Set(fullIds.map((r) => r.id))
    const outRows = slim ? rows.map((r) => ({ ...r, has_full_data: fullIdSet.has(r.id) })) : rows
    return { project_id: id, total, [kind === 'sync-log' ? 'sync_log' : kind]: outRows }
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
  // One row, full (trades include full_data), for a detail view.
  // Used by the Database Details popup so a list page never needs
  // full_data for every row. Project check first, then row in project.
  async GET(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const kind = collection(req)
    const rid = rowId(req)
    await visibleProject(sb, id)
    const row = check(await sb.from(TABLES[kind]).select('*').eq('id', rid).eq('project_id', id).maybeSingle())
    if (!row) throw new HttpError(404, 'Row not found in this project or not visible to you')
    const singular = { queue: 'queue_item', trades: 'trade', references: 'reference', notes: 'note', 'sync-log': 'sync_log' }[kind]
    return { [singular]: row }
  },

  async PATCH(req) {
    const { sb } = await auth(req)
    const id = projectId(req)
    const kind = collection(req)
    if (!PATCHABLE[kind]) throw new HttpError(405, `Only queue, trade, and note rows can be updated this way`)
    const rid = rowId(req)
    await visibleProject(sb, id)
    const b = body(req)
    // full_data, when present, must be a plain JSON object (the full
    // TradesDB row). Arrays, strings, numbers and null are rejected, so
    // a bad backfill payload cannot overwrite the column with junk, and
    // clean() below cannot trim or reshape an object it should not touch.
    if (kind === 'trades' && b.full_data !== undefined) {
      const fd = b.full_data
      if (fd === null || Array.isArray(fd) || typeof fd !== 'object') throw new HttpError(400, 'full_data must be a JSON object')
    }
    const row = clean(b, PATCHABLE[kind])
    if (row.status !== undefined && !QUEUE_STATUSES.includes(row.status)) throw new HttpError(400, `status must be one of: ${QUEUE_STATUSES.join(', ')}`)
    if (row.stage !== undefined && !TRADE_STAGES.includes(row.stage)) throw new HttpError(400, `stage must be one of: ${TRADE_STAGES.join(', ')}`)
    if (row.queue_id !== undefined) await childInProject(sb, 'trade_queue', row.queue_id, id)
    if (kind === 'notes' && row.trade_id !== undefined) await childInProject(sb, 'trades', row.trade_id, id)
    if (Object.keys(row).length === 0) throw new HttpError(400, 'Nothing to update')
    const saved = check(await sb.from(TABLES[kind]).update(row).eq('id', rid).eq('project_id', id).select().maybeSingle())
    if (!saved) throw new HttpError(404, 'Row not found in this project or not visible to you')
    const singular = { queue: 'queue_item', trades: 'trade', notes: 'note' }[kind]
    return { [singular]: saved }
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
