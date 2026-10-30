import { useEffect, useState } from 'react'

// Server-backed Project pages for the Mercancia trade upgrade.
// Projects now live in the server tables from migration 0019
// (projects, trade_queue, trades, trade_references, trade_notes,
// trade_sync_log), read and written through /api/projects, never in
// browser localStorage. Every request runs as the signed-in caller under
// the normal row-level security rules: a project is visible only to its
// owner, the group owner (username 'mubarak'), or an AI member ('adam'
// or 'ali'); other members get no rows.
// SYNC ARCHITECTURE (read before changing this file): the app and
// Vercel have NO Google credentials for the user's account, so this
// page NEVER writes to Google Sheets, Drive, or Apps Script directly.
// A Sync tap only records a request in the in-app trade_sync_log
// (target 'sync_request'); the operator sync script
// (~/workspace/sync-trades-to-clean-sheet.py, outside this repo,
// run by Adam, who has the connected Drive/Sheets) is what appends
// rows to the clean sheet in NEW STEALTH FOLDER and then records
// the completed attempt (target 'google_sheet', success true/false)
// in the same log. Ali has NO Drive/Sheets connection and NEVER
// executes a sync: Ali finishes a trade in-app via the group-chat
// API and marks it ready by posting the same 'sync_request' row;
// Adam's script is the sole executor. A trade is synced ONCE ONLY:
// any successful 'google_sheet' row blocks every later sync of that
// trade, even after a new request. Auto sync is the same script in
// auto mode: it picks up trades with stage 'new' created after the
// clean sheet was cleared that ALSO have a 'sync_request' row and
// no successful 'google_sheet' row; stage 'new' alone, without a
// request, is never synced, and it never touches the 206 seeded
// 'matched' trades. See SYNC_ARCHITECTURE.md in this work copy.
// Sheet tabs as app pages: Database = TradesDB, References = Shadow
// Reference Bridge (stored fields only), Notes = Shadow Notes Log
// (stored fields only). The sheet columns that were never seeded into
// these tables are not shown and not invented: References has no
// participant-domains column stored, and Notes has no execution stage,
// action owner, deadline, or counterparty column stored.

async function apiFetch(token, path, method = 'GET', bodyJson) {
  if (!token) throw new Error('You are not signed in. Sign in again to open projects.')
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: bodyJson ? JSON.stringify(bodyJson) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    // Non-JSON error page: fall through to the status message below.
  }
  if (!res.ok) throw new Error(data?.error || `Project request failed (HTTP ${res.status})`)
  return data
}

export async function listProjects(token) {
  const data = await apiFetch(token, '/api/projects')
  return Array.isArray(data.projects) ? data.projects : []
}

export async function createProject(token, name) {
  const data = await apiFetch(token, '/api/projects', 'POST', { name })
  return data.project
}

export async function fetchDashboard(token, projectId) {
  return apiFetch(token, `/api/projects/${projectId}`)
}

// All rows of one subcollection for a project, paged through the
// subcollection GET. The dashboard GET caps at 200 rows, and the seeded
// collections exceed that (trades 206, references 255, notes 1471), so
// a single page would silently drop rows. The subcollection GET in
// server/routes/projects.js already handles limit/offset the same way
// for every collection (order by id, range), with the default exactly
// the old first-200 behaviour, so no server change was needed here:
// this helper just pages through it. Response keys are the collection
// names themselves (trades, references, notes).
export async function fetchAllCollection(token, projectId, kind) {
  const all = []
  let offset = 0
  for (;;) {
    const data = await apiFetch(token, `/api/projects/${projectId}/${kind}?limit=200&offset=${offset}`)
    const page = Array.isArray(data[kind]) ? data[kind] : []
    all.push(...page)
    if (page.length < 200) break
    offset += 200
  }
  return all
}

export async function fetchAllTrades(token, projectId) {
  return fetchAllCollection(token, projectId, 'trades')
}

// Manual sync request for ONE trade only. This does NOT write to
// Google Sheets: it records a request row in the in-app sync log
// (target 'sync_request', success false, failure_reason explaining
// it is awaiting the operator script). The operator script's manual
// mode finds that row and syncs that trade regardless of stage,
// then posts the completed 'google_sheet' row. No server change
// was needed: POST /sync-log already accepts trade_id, target,
// success and failure_reason.
export async function requestManualSync(token, projectId, tradeId) {
  const data = await apiFetch(token, `/api/projects/${projectId}/sync-log`, 'POST', {
    trade_id: tradeId,
    target: 'sync_request',
    success: false,
    failure_reason: 'manual sync requested, awaiting operator sync',
  })
  return data.sync_log
}

// Whole-page projects list. Back goes to chats.
export function ProjectsList({ projects, loading, error, onCreate, onOpen, onBack }) {
  return (
    <main className="project-page" aria-label="Projects">
      <header className="project-header">
        <button className="project-back" onClick={onBack} aria-label="Back to chats">
          &lsaquo; Back to chats
        </button>
        <h1>project</h1>
      </header>
      <p className="muted">Projects are containers for trade work. Each project gets its own queue, stages, database, references, notes, and sync log views.</p>
      <button className="primary project-create-btn" onClick={onCreate}>
        Create new project
      </button>
      {error ? (
        <p className="project-empty">{error}</p>
      ) : loading ? (
        <p className="project-empty">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="project-empty">No projects yet. Create one to open its dashboard.</p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button className="project-row" onClick={() => onOpen(p)} aria-label={`Open project ${p.name}`}>
                <span className="project-row-name">{p.name}</span>
                <span className="muted">Open dashboard &rsaquo;</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

// Whole-page create project form. Done is disabled until a trimmed name exists.
export function CreateProject({ onDone, onBack, error }) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <main className="project-page" aria-label="Create a project">
      <header className="project-header">
        <button className="project-back" onClick={onBack} aria-label="Back to projects">
          &lsaquo; Back
        </button>
        <h1>Create a project</h1>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed) onDone(trimmed)
        }}
      >
        <label className="project-label" htmlFor="project-name">
          Project name
        </label>
        <input
          id="project-name"
          className="project-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Mercancia Trade Capture"
          autoFocus
          autoComplete="off"
        />
        <button className="primary project-done-btn" type="submit" disabled={!trimmed}>
          Done
        </button>
      </form>
      {error ? <p className="project-empty">{error}</p> : null}
      <p className="muted">Done opens a new dashboard for this project. Sync to Google Sheets is by the operator script only; this app records sync requests and results in the Sync log, and never writes to Sheets, Drive, or Apps Script itself.</p>
    </main>
  )
}

const STAGES = [
  { key: 'extracted', label: 'extracted', text: 'Adam has extracted trade details, awaiting finishing.' },
  { key: 'finished', label: 'finished', text: 'Ali has completed the entry.' },
  { key: 'matched', label: 'matched', text: 'Linked to an existing trade by contract ref.' },
  { key: 'new', label: 'new', text: 'A brand-new trade, not matched to an existing one.' },
]

const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))
const when = (v) => {
  try {
    return v ? new Date(v).toLocaleString() : '—'
  } catch {
    return '—'
  }
}

// Whole-page dashboard for one project. Tabs, not a chat pane.
// Stage counts come from server data, not local counts: trades in that
// stage, plus queue rows in the same status that have no trade yet (a
// queue row linked to a trade is counted once, under the trade).
// Simplified fallback columns, used only when no trade has full_data
// yet (before the backfill runs). Each entry is [header, field].
const SIMPLE_COLUMNS = [
  ['Contract ref', 'contract_ref'],
  ['Buyer', 'buyer'],
  ['Seller', 'seller'],
  ['Commodity', 'commodity'],
  ['Quantity', 'quantity'],
  ['Disport', 'disport'],
  ['Stage', 'stage'],
]

// Stored fields only, from migration 0019 and the seed payloads.
// References: shadow_ref, live_refs, external_refs, fingerprint, plus
// updated_at. The sheet's Associated_Domains_Emails column was not
// seeded into this table, so it is not shown here.
// Notes: message_id, trade_id, subject, summary, priority,
// action_required, plus created_at. The sheet's execution stage, action
// owner, deadline, and counterparty columns were not seeded into this
// table, so they are not shown here. trade_id is the in-app trade row
// id, not a contract ref; null means the note had no matching trade.
const REFERENCE_COLUMNS = [
  ['Shadow ref', 'shadow_ref'],
  ['Live refs', 'live_refs'],
  ['External refs', 'external_refs'],
  ['Fingerprint', 'fingerprint'],
  ['Updated', 'updated_at'],
]
const NOTE_COLUMNS = [
  ['Message ID', 'message_id'],
  ['Linked trade ID', 'trade_id'],
  ['Subject', 'subject'],
  ['Summary', 'summary'],
  ['Priority', 'priority'],
  ['Action required', 'action_required'],
  ['Created', 'created_at'],
]

// Exact TradesDB header order, read from the user's copy sheet
// (TradesDB tab, first row) for this build only. full_data is stored
// as jsonb, which sorts keys by length then alphabetically and so
// loses sheet order; ordering by this list restores the sheet order
// (timestamp, Mercancia_Contract_ref, trade_date, and onward) without
// changing stored data. The sheet header 'commission' appears twice;
// it is kept once here, so the list has 116 unique names for 117
// sheet headers. Any full_data key not in this list goes at the end,
// in full_data order, never first. Stage is appended last by the
// Database view and is not a TradesDB column.
const TRADESDB_SHEET_COLUMNS = ["timestamp", "Mercancia_Contract_ref", "trade_date", "purchase_or_sale", "total_quantity", "quantity_unit", "commodity_name", "origin", "incoterm", "destination_port", "shipment_window", "unit_price", "currency", "price_per_unit", "seller_name", "seller_address", "seller_contact", "seller_email", "seller_phone", "seller_signatory", "buyer_name", "buyer_address", "buyer_contact", "buyer_email", "buyer_phone", "buyer_signatory", "direct_business", "broker_name", "broker_address", "broker_contact", "broker_email", "broker_phone", "commission", "crop_year", "moisture_max", "protein_min", "oil_min", "purity_min", "admixture_max", "fibre_max", "ash_max", "starch_min", "aflatoxin_limit", "nut_count", "outturn_kor", "weevilled_max", "natural_variation", "physical_condition", "cleaning_method", "tolerance", "tolerance_type", "cargo_type", "container_type", "total_containers", "load_per_container", "partial_shipment", "transshipment", "free_time_dest", "shipment_advice", "insurance", "demurrage_free_time", "packing_type", "packing_size", "shipping_marks", "tagging_labels", "weight_quality_basis", "inspection_agency", "inspection_paid_by", "silica_gel", "fumigation_type", "container_lining", "inland_haulage", "thc_status", "payment_terms", "key_deadline", "beneficiary_name", "bank_name", "account_number", "swift_bic", "gst_number", "pan_number", "iec_code", "fssai_number", "exim_code", "arbitration_law", "import_permit_noc", "doc_instructions", "required_documents", "addendum_notes", "raw_message", "last_update", "contract_issuer", "additional_information", "trader_name", "product_category", "Parent_Folder_URL", "authorized_signatory", "back_to_back_source_ref", "column_98", "contract_no", "direction", "Folder_Banking_URL", "Folder_Contacts_URL", "Folder_Docs_URL", "Folder_Logistics_URL", "Folder_Packing_URL", "Folder_Specs_URL", "Has_notes", "mercancia_ref", "modification_notes", "Notes", "parent_reference", "Sender_Email", "trade_status", "trade_type", "WhatsApp_number"]

export function ProjectDashboard({ project, token, onBack }) {
  const [tab, setTab] = useState('queue')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Database, References, and Notes tabs load separately, paged, so
  // all seeded rows appear, not just the dashboard's capped first 200
  // (trades 206, references 255, notes 1471).
  const [dbTrades, setDbTrades] = useState(null)
  const [dbLoading, setDbLoading] = useState(false)
  const [dbError, setDbError] = useState('')
  const [refRows, setRefRows] = useState(null)
  const [refLoading, setRefLoading] = useState(false)
  const [refError, setRefError] = useState('')
  const [noteRows, setNoteRows] = useState(null)
  const [noteLoading, setNoteLoading] = useState(false)
  const [noteError, setNoteError] = useState('')
  // Queue and Stages tabs also need full, paged lists, not the
  // dashboard's capped first 200 rows: Stages counted 200 matched
  // trades instead of the true 206, and a queue over 200 rows would
  // be cut the same way. These load lazily on tab switch, like the
  // Database, References, and Notes tabs, and fall back to the
  // dashboard lists only while the paged load is in progress.
  const [allQueue, setAllQueue] = useState(null)
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueError, setQueueError] = useState('')
  // Manual sync: one pending request at a time, by trade id, plus
  // the last request message shown above the Database table.
  const [syncBusyId, setSyncBusyId] = useState(null)
  const [syncMessage, setSyncMessage] = useState('')
  const [syncError, setSyncError] = useState('')
  // Raw message popup: { ref, text } or null. The table cell shows a
  // View button only, never the full message text, so raw_message
  // cannot take over the whole screen.
  const [rawMessage, setRawMessage] = useState(null)

  useEffect(() => {
    if (!rawMessage) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setRawMessage(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rawMessage])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetchDashboard(token, project.id)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load this project.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, project.id])

  useEffect(() => {
    if ((tab !== 'database' && tab !== 'stages') || dbTrades !== null) return undefined
    let cancelled = false
    setDbLoading(true)
    setDbError('')
    fetchAllTrades(token, project.id)
      .then((rows) => {
        if (!cancelled) setDbTrades(rows)
      })
      .catch((err) => {
        if (!cancelled) setDbError(err.message || 'Could not load trades.')
      })
      .finally(() => {
        if (!cancelled) setDbLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, token, project.id, dbTrades])

  useEffect(() => {
    if (tab !== 'references' || refRows !== null) return undefined
    let cancelled = false
    setRefLoading(true)
    setRefError('')
    fetchAllCollection(token, project.id, 'references')
      .then((rows) => {
        if (!cancelled) setRefRows(rows)
      })
      .catch((err) => {
        if (!cancelled) setRefError(err.message || 'Could not load references.')
      })
      .finally(() => {
        if (!cancelled) setRefLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, token, project.id, refRows])

  useEffect(() => {
    if (tab !== 'notes' || noteRows !== null) return undefined
    let cancelled = false
    setNoteLoading(true)
    setNoteError('')
    fetchAllCollection(token, project.id, 'notes')
      .then((rows) => {
        if (!cancelled) setNoteRows(rows)
      })
      .catch((err) => {
        if (!cancelled) setNoteError(err.message || 'Could not load notes.')
      })
      .finally(() => {
        if (!cancelled) setNoteLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, token, project.id, noteRows])

  useEffect(() => {
    if ((tab !== 'queue' && tab !== 'stages') || allQueue !== null) return undefined
    let cancelled = false
    setQueueLoading(true)
    setQueueError('')
    fetchAllCollection(token, project.id, 'queue')
      .then((rows) => {
        if (!cancelled) setAllQueue(rows)
      })
      .catch((err) => {
        if (!cancelled) setQueueError(err.message || 'Could not load queue.')
      })
      .finally(() => {
        if (!cancelled) setQueueLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, token, project.id, allQueue])

  const queue = data?.queue ?? []
  const trades = data?.trades ?? []
  const syncLog = data?.sync_log ?? []
  // Stages and Queue use the full paged lists when loaded, falling
  // back to the dashboard's capped lists only while loading. With
  // all 206 seeded trades at stage 'matched' and an empty queue,
  // Stages now shows Matched 206, not the dashboard cap of 200.
  const stageTrades = dbTrades ?? trades
  const stageQueue = allQueue ?? queue
  const linkedQueueIds = new Set(stageTrades.map((t) => t.queue_id).filter((id) => id != null))
  const stageCount = (key) =>
    stageTrades.filter((t) => t.stage === key).length +
    stageQueue.filter((q) => q.status === key && !linkedQueueIds.has(q.id)).length
  const queueRows = allQueue ?? queue

  // Database columns are dynamic, not hardcoded: they come from the
  // full_data keys of the first trade that has full_data, in the order
  // the backfill stored them (sheet header order), plus the app Stage
  // column at the end, which is not a TradesDB column. Trades without
  // full_data render '—' in the full columns and still show Stage, so
  // the page works before the backfill runs. If no trade has full_data
  // at all, the old simplified columns are used instead.
  const dbRows = dbTrades ?? trades
  const firstFull = dbRows.find((t) => t.full_data && typeof t.full_data === 'object' && !Array.isArray(t.full_data))
  const dbColumns = firstFull
    ? [...TRADESDB_SHEET_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(firstFull.full_data, c)), ...Object.keys(firstFull.full_data).filter((c) => !TRADESDB_SHEET_COLUMNS.includes(c)), 'Stage', 'Sync']
    : [...SIMPLE_COLUMNS.map(([h]) => h), 'Sync']
  const dbCell = (t, col) => {
    if (col === 'Stage') return show(t.stage)
    if (firstFull) return t.full_data && typeof t.full_data === 'object' ? show(t.full_data[col]) : '—'
    const field = SIMPLE_COLUMNS.find(([h]) => h === col)?.[1]
    return show(field ? t[field] : undefined)
  }
  const dbFullCount = dbRows.filter((t) => t.full_data && typeof t.full_data === 'object').length
  // A trade has a pending manual request when the log has a
  // 'sync_request' row for it with no completed 'google_sheet' row
  // after it. The dashboard log is capped at 200, newest first,
  // so a very old request could fall off this list; the operator
  // script reads the full paged log and is the authority.
  const pendingSyncIds = new Set(
    (syncLog || [])
      .filter((s) => s.target === 'sync_request')
      .filter((s) => !(syncLog || []).some((c) => c.target === 'google_sheet' && c.trade_id === s.trade_id && c.created_at >= s.created_at))
      .map((s) => s.trade_id)
  )
  // Once-only dedupe in the UI: a trade with any successful
  // 'google_sheet' row shows 'Synced' and cannot be requested
  // again from here, so a second tap cannot duplicate its row
  // in the clean sheet. The operator script enforces the same
  // rule even if a request row somehow arrives anyway.
  const syncedIds = new Set(
    (syncLog || []).filter((s) => s.target === 'google_sheet' && s.success).map((s) => s.trade_id)
  )
  const onRequestSync = async (trade) => {
    setSyncError('')
    setSyncMessage('')
    setSyncBusyId(trade.id)
    try {
      await requestManualSync(token, project.id, trade.id)
      setSyncMessage(`Sync requested for ${trade.contract_ref || `trade ${trade.id}`}. The operator sync will append it to the clean sheet and log the result in the Sync log tab.`)
      const fresh = await fetchDashboard(token, project.id)
      setData(fresh)
    } catch (err) {
      setSyncError(err.message || 'Could not record the sync request.')
    } finally {
      setSyncBusyId(null)
    }
  }

  // Every dashboard tab uses the wide page variant (no 900px cap),
  // so Queue and Stages match Database, References, Notes, and Sync
  // log instead of sitting narrow and centered while the sheet-like
  // tabs stretch full width. The project list and create form are
  // separate components and keep the centered page. The per-tab
  // class on main is only for the per-page header colour in
  // styles.css; it changes no layout on its own.
  const wide = true
  return (
    <main className={`project-page${wide ? ' project-page-wide' : ''} project-page-${tab}`} aria-label={`Dashboard for ${project.name}`}>
      <header className="project-header">
        <button className="project-back" onClick={onBack} aria-label="Back to projects">
          &lsaquo; Back to projects
        </button>
        <h1>{project.name}</h1>
      </header>
      <nav className="project-tabs" aria-label="Dashboard sections">
        {[
          ['queue', 'Queue'],
          ['stages', 'Stages'],
          ['database', 'Database view'],
          ['references', 'References'],
          ['notes', 'Notes'],
          ['log', 'Sync log'],
        ].map(([key, label]) => (
          <button key={key} className={`project-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} aria-selected={tab === key}>
            {label}
          </button>
        ))}
      </nav>

      {loading ? (
        <p className="project-empty">Loading dashboard…</p>
      ) : error ? (
        <p className="project-empty">{error}</p>
      ) : (
        <>
          {tab === 'queue' && (
            <section aria-label="Queue">
              <h2>Queue</h2>
              {queueLoading ? (
                <p className="project-empty">Loading queue…</p>
              ) : queueError ? (
                <p className="project-empty">{queueError}</p>
              ) : queueRows.length === 0 ? (
                <p className="project-empty">No trades queued yet. The one-trader test will land here.</p>
              ) : (
                <ul className="project-list">
                  {queueRows.map((q) => (
                    <li key={q.id}>
                      <div className="project-row">
                        <span className="project-row-name">{show(q.subject || q.message_id)}</span>
                        <span className="muted">
                          {show(q.sender)} · {q.status} · {when(q.created_at)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === 'stages' && (
            <section aria-label="Stages">
              <h2>Stages</h2>
              {dbLoading ? <p className="muted">Loading all trades for exact counts…</p> : null}
              <div className="project-stage-grid">
                {STAGES.map((s) => (
                  <article key={s.key} className="project-stage-card">
                    <div className="project-stage-count">{stageCount(s.key)}</div>
                    <h3>{s.label}</h3>
                    <p className="muted">{s.text}</p>
                  </article>
                ))}
              </div>
            </section>
          )}

          {tab === 'database' && (
            <section aria-label="Database view">
              <h2>Database view</h2>
              {syncMessage ? <p className="project-empty">{syncMessage}</p> : null}
              {syncError ? <p className="project-empty">{syncError}</p> : null}
              <p className="muted">
                Own database view inside the app, full width like the TradesDB sheet. Scroll sideways for more columns.
                {dbRows.length > 0 && firstFull
                  ? (dbFullCount === dbRows.length
                      ? ` All ${dbRows.length} trades have full trade data.`
                      : ` ${dbFullCount} of ${dbRows.length} trades have full trade data; the rest show —.`)
                  : dbRows.length > 0
                    ? ' Full trade data has not been backfilled yet, so the simplified columns are shown.'
                    : ''}
              </p>
              {dbLoading ? (
                <p className="project-empty">Loading trades…</p>
              ) : dbError ? (
                <p className="project-empty">{dbError}</p>
              ) : (
                <div className="project-table-wrap">
                  <table className="project-table">
                    <thead>
                      <tr>
                        <th className="sn-col">S/N</th>
                        {dbColumns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dbRows.length === 0 ? (
                        <tr>
                          <td colSpan={Math.max(dbColumns.length, 1) + 1} className="project-empty">
                            No trades saved yet.
                          </td>
                        </tr>
                      ) : (
                        dbRows.map((t, i) => (
                          <tr key={t.id}>
                            <td className="sn-col">{i + 1}</td>
                            {dbColumns.map((col) =>
                              col === 'raw_message' && firstFull ? (
                                <td key={col} className="raw-message-cell">
                                  <button
                                    type="button"
                                    className="raw-message-btn"
                                    onClick={() =>
                                      setRawMessage({
                                        ref: t.full_data?.Mercancia_Contract_ref || t.contract_ref || '',
                                        text: t.full_data?.raw_message || '',
                                      })
                                    }
                                    aria-label={`View raw message for ${t.full_data?.Mercancia_Contract_ref || t.contract_ref || 'this trade'}`}
                                  >
                                    View
                                  </button>
                                </td>
                              ) : col === 'Sync' ? (
                                <td key={col}>
                                  <button
                                    type="button"
                                    className="raw-message-btn"
                                    disabled={syncBusyId === t.id || pendingSyncIds.has(t.id) || syncedIds.has(t.id)}
                                    onClick={() => onRequestSync(t)}
                                    aria-label={`Request sync for ${t.contract_ref || `trade ${t.id}`}`}
                                  >
                                    {syncedIds.has(t.id) ? 'Synced' : pendingSyncIds.has(t.id) ? 'Sync requested' : syncBusyId === t.id ? 'Requesting…' : 'Sync'}
                                  </button>
                                </td>
                              ) : (
                                <td key={col}>{dbCell(t, col)}</td>
                              )
                            )}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {tab === 'references' && (
            <section aria-label="References">
              <h2>References</h2>
              <p className="muted">
                Shadow Reference Bridge inside the app, full width like the sheet. Scroll sideways for more columns.
                {refRows !== null ? ` ${refRows.length} references.` : ''}
              </p>
              {refLoading ? (
                <p className="project-empty">Loading references…</p>
              ) : refError ? (
                <p className="project-empty">{refError}</p>
              ) : (
                <div className="project-table-wrap">
                  <table className="project-table">
                    <thead>
                      <tr>
                        <th className="sn-col">S/N</th>
                        {REFERENCE_COLUMNS.map(([h]) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(refRows ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={REFERENCE_COLUMNS.length + 1} className="project-empty">
                            No references saved yet.
                          </td>
                        </tr>
                      ) : (
                        (refRows ?? []).map((r, i) => (
                          <tr key={r.id}>
                            <td className="sn-col">{i + 1}</td>
                            {REFERENCE_COLUMNS.map(([h, field]) => (
                              <td key={h}>{field === 'updated_at' ? when(r[field]) : show(r[field])}</td>
                            ))}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {tab === 'notes' && (
            <section aria-label="Notes">
              <h2>Notes</h2>
              <p className="muted">
                Shadow Notes Log inside the app, full width like the sheet. Scroll sideways for more columns. A blank linked trade ID means the note had no matching trade.
                {noteRows !== null ? ` ${noteRows.length} notes.` : ''}
              </p>
              {noteLoading ? (
                <p className="project-empty">Loading notes…</p>
              ) : noteError ? (
                <p className="project-empty">{noteError}</p>
              ) : (
                <div className="project-table-wrap">
                  <table className="project-table">
                    <thead>
                      <tr>
                        <th className="sn-col">S/N</th>
                        {NOTE_COLUMNS.map(([h]) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(noteRows ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={NOTE_COLUMNS.length + 1} className="project-empty">
                            No notes saved yet.
                          </td>
                        </tr>
                      ) : (
                        (noteRows ?? []).map((n, i) => (
                          <tr key={n.id}>
                            <td className="sn-col">{i + 1}</td>
                            {NOTE_COLUMNS.map(([h, field]) => (
                              <td key={h}>{field === 'created_at' ? when(n[field]) : show(n[field])}</td>
                            ))}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {tab === 'log' && (
            <section aria-label="Sync log">
              <h2>Sync log</h2>
              <p className="muted">In-app sync requests and attempts, not the Notes log. A row with target sync_request is a Sync tap, or Ali marking a finished trade ready, awaiting Adam's operator script; a row with target google_sheet is a completed attempt by that script. A trade with a successful google_sheet row is synced once only and is never re-appended. The app never writes to Sheets itself, and Ali never executes a sync.</p>
              {syncLog.length === 0 ? (
                <p className="project-empty">No log entries yet.</p>
              ) : (
                <ul className="project-list">
                  {syncLog.map((s) => (
                    <li key={s.id}>
                      <div className="project-row">
                        <span className="project-row-name">
                          {show(s.target)} · {s.target === 'sync_request' ? 'requested' : s.success ? 'ok' : 'failed'} · trade {s.trade_id}
                        </span>
                        <span className="muted">
                          {show(s.failure_reason)} · {when(s.created_at)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
      {rawMessage && (
        <div className="raw-message-backdrop" onClick={() => setRawMessage(null)} role="presentation">
          <div
            className="raw-message-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Raw message for ${rawMessage.ref}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="raw-message-dialog-head">
              <strong>{rawMessage.ref ? `Raw message: ${rawMessage.ref}` : 'Raw message'}</strong>
              <button type="button" className="raw-message-close" onClick={() => setRawMessage(null)} aria-label="Close raw message">
                Close
              </button>
            </div>
            <div className="raw-message-dialog-body">{rawMessage.text || 'No raw message stored for this trade.'}</div>
          </div>
        </div>
      )}
    </main>
  )
}
