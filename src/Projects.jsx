import { useEffect, useRef, useState } from 'react'

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
  // Fast dashboard (server change, this build): project row, exact
  // counts, stage counts, sync summary, emptyColumns and
  // databaseColumns, plus the latest 20 slim trades and latest 20
  // notes only. No 200-row full collections, no full_data payload.
  // Full tables are paged through fetchPage below, 50 rows at a time.
  return apiFetch(token, `/api/projects/${projectId}`)
}

// One page of one collection, 50 rows, server limit/offset, with a
// total count. Trades use ?slim=1: slim fields only, no full_data.
// Returns { rows, total }.
export async function fetchPage(token, projectId, kind, page) {
  const offset = page * 50
  const slim = kind === 'trades' ? '&slim=1' : ''
  const data = await apiFetch(token, `/api/projects/${projectId}/${kind}?limit=50&offset=${offset}${slim}`)
  const key = kind === 'sync-log' ? 'sync_log' : kind
  return { rows: Array.isArray(data[key]) ? data[key] : [], total: typeof data.total === 'number' ? data.total : 0 }
}

// One trade row, full, for the Database Details popup only. This is
// the only place a list view ever loads full_data, and only for the
// one trade the user tapped. Returns the trade row (full_data may be
// null if the trade was never backfilled).
export async function fetchTradeDetail(token, projectId, tradeId) {
  const data = await apiFetch(token, `/api/projects/${projectId}/trades/${tradeId}`)
  return data.trade
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
// Legacy full-list helper, kept for API compatibility only. The
// dashboard no longer calls it: it pages with fetchPage, 50 at a time.
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
        <div className="project-list-topbar">
          <button className="project-back" onClick={onBack} aria-label="Back to chats">
            &lsaquo; Back to chats
          </button>
          <button className="project-list-new" onClick={onCreate} aria-label="Create new project">
            + New
          </button>
        </div>
        <h1>Projects</h1>
      </header>
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
                <span className="project-row-arrow" aria-hidden="true">&rsaquo;</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

// Whole-page create project form. Done is disabled until a trimmed name exists.
export function CreateProject({ onDone, onBack, onBackToChats, error }) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  return (
    <main className="project-page" aria-label="Create a project">
      <header className="project-header">
        <div className="project-header-actions">
          <button className="project-back" onClick={onBack} aria-label="Back to projects">
            &lsaquo; Back to projects
          </button>
          {onBackToChats ? (
            <button className="project-back" onClick={onBackToChats} aria-label="Back to chats">
              &lsaquo; Back to chats
            </button>
          ) : null}
        </div>
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

// Database design (user mock, 2026-10-31): party cells with avatar
// initials and a tint, stage pills, and a visible "Not set" for a
// blank buyer or seller. Display only: this never invents a party,
// never patches a trade or a note, and never changes stored data.
const AVATAR_PALETTE = [
  ['#E7F3FF', '#0750C7'],
  ['#E3F6E8', '#12702B'],
  ['#EDE7FF', '#4B2BB8'],
  ['#FDE8EF', '#A31650'],
]
function partyTheme(name) {
  const words = String(name).replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean)
  const initials = ((words[0] || '?')[0] + (words[1] ? words[1][0] : '')).toUpperCase()
  let sum = 0
  for (const ch of String(name)) sum += ch.charCodeAt(0)
  const [bg, fg] = AVATAR_PALETTE[sum % AVATAR_PALETTE.length]
  return { initials, bg, fg }
}
function PartyCell({ name }) {
  if (name === null || name === undefined || String(name).trim() === '') {
    return (
      <span className="db-party db-party--empty">
        <span className="db-avatar db-avatar--empty" aria-hidden="true">?</span>
        <span className="db-party-name">Not set</span>
      </span>
    )
  }
  const t = partyTheme(name)
  return (
    <span className="db-party">
      <span className="db-avatar" aria-hidden="true" style={{ background: t.bg, color: t.fg }}>{t.initials}</span>
      <span className="db-party-name">{String(name)}</span>
    </span>
  )
}
function StagePill({ stage }) {
  if (stage === 'matched') return <span className="db-pill db-pill--matched">Matched</span>
  if (stage === 'new') return <span className="db-pill db-pill--new">New</span>
  return <span className="db-pill db-pill--other">{show(stage)}</span>
}
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

const PAGE_SIZE = 50
const SLIM_DB_COLUMNS = [
  ['Contract ref', 'contract_ref'],
  ['Buyer', 'buyer'],
  ['Seller', 'seller'],
  ['Commodity', 'commodity'],
  ['Quantity', 'quantity'],
  ['Disport', 'disport'],
  ['Stage', 'stage'],
]

function Pager({ page, total, onPage }) {
  const start = total === 0 ? 0 : page * PAGE_SIZE + 1
  const end = Math.min(total, (page + 1) * PAGE_SIZE)
  const lastPage = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE)
  return (
    <div className="project-pager" role="navigation" aria-label="Page">
      <button type="button" className="project-pager-btn" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        &lsaquo; Previous
      </button>
      <span className="muted">
        Showing {start}-{end} of {total}
      </span>
      <button type="button" className="project-pager-btn" disabled={page >= lastPage} onClick={() => onPage(page + 1)}>
        Next &rsaquo;
      </button>
    </div>
  )
}

export function ProjectDashboard({ project, token, onBack, onBackToChats }) {
  const [tab, setTab] = useState('queue')
  const [panelOpen, setPanelOpen] = useState(false)
  const panelCloseRef = useRef(null)
  const closePanel = () => setPanelOpen(false)
  const goToTab = (key) => {
    setTab(key)
    setPanelOpen(false)
  }
  const goToChats = () => {
    setPanelOpen(false)
    if (onBackToChats) onBackToChats()
    else onBack()
  }
  const goToProjects = () => {
    setPanelOpen(false)
    onBack()
  }
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Paged tables, cached per project in this session: switching tabs
  // never refetches a page already loaded, and opening the dashboard
  // never loads a full table at all. Key is `${kind}:${page}`.
  const [pages, setPages] = useState({})
  const [pageNums, setPageNums] = useState({ queue: 0, stages: 0, latest: 0, database: 0, references: 0, notes: 0, log: 0 })
  const [pageLoading, setPageLoading] = useState({})
  const [pageError, setPageError] = useState({})
  const [syncBusyId, setSyncBusyId] = useState(null)
  const [syncMessage, setSyncMessage] = useState('')
  const [syncError, setSyncError] = useState('')
  // Database long-text columns are View buttons in the list, exactly
  // as before, but tapping one fetches that single trade only, so
  // the list never needs full_data for every row. The Details popup
  // shows the whole full sheet row for one trade, also on tap only.
  const LONG_TEXT_COLUMNS = ['addendum_notes', 'Notes', 'doc_instructions', 'required_documents', 'additional_information', 'raw_message']
  const NOTE_LONG_TEXT_FIELDS = ['message_id', 'subject', 'summary']
  const [rawMessage, setRawMessage] = useState(null)
  // Database Details popup: one trade, full_data loaded on tap only.
  const [detail, setDetail] = useState(null)
  const [showEmptyColumns, setShowEmptyColumns] = useState(false)
  // Database design: search and stage filter. Page-local only: the
  // paged API has no search endpoint, so these filter the 50 rows
  // already loaded for the current page, never the whole collection.
  const [dbQuery, setDbQuery] = useState('')
  const [dbStage, setDbStage] = useState('all')

  useEffect(() => {
    if (!rawMessage && !detail && !panelOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setRawMessage(null)
        setDetail(null)
        setPanelOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rawMessage, detail, panelOpen])

  // Side panel: focus the close button first when it opens, and stop
  // the page behind it from scrolling while it is open.
  useEffect(() => {
    if (!panelOpen) return undefined
    if (panelCloseRef.current) panelCloseRef.current.focus()
    const prevBody = document.body.style.overflow
    const prevHtml = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevBody
      document.documentElement.style.overflow = prevHtml
    }
  }, [panelOpen])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setData(null)
    setPages({})
    setPageNums({ queue: 0, stages: 0, latest: 0, database: 0, references: 0, notes: 0, log: 0 })
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

  const tabKind = { queue: 'queue', database: 'trades', references: 'references', notes: 'notes', log: 'sync-log' }[tab]
  const tabPage = pageNums[tab] ?? 0
  useEffect(() => {
    if (!tabKind) return undefined
    const key = `${tabKind}:${tabPage}`
    if (pages[key]) return undefined
    let cancelled = false
    setPageLoading((prev) => ({ ...prev, [key]: true }))
    setPageError((prev) => ({ ...prev, [key]: '' }))
    fetchPage(token, project.id, tabKind, tabPage)
      .then((res) => {
        if (!cancelled) setPages((prev) => ({ ...prev, [key]: res }))
      })
      .catch((err) => {
        if (!cancelled) setPageError((prev) => ({ ...prev, [key]: err.message || 'Could not load this page.' }))
      })
      .finally(() => {
        if (!cancelled) setPageLoading((prev) => ({ ...prev, [key]: false }))
      })
    return () => {
      cancelled = true
    }
  }, [tab, tabKind, tabPage, token, project.id, pages])

  const counts = data?.counts ?? {}
  const stageCounts = data?.stageCounts ?? {}
  const pendingSyncIds = new Set(data?.pendingSyncIds ?? [])
  const syncedIds = new Set(data?.syncedIds ?? [])
  const databaseColumns = Array.isArray(data?.databaseColumns) ? data.databaseColumns : []
  const serverEmptyColumns = Array.isArray(data?.emptyColumns) ? data.emptyColumns : []
  const isEmptyCellValue = (v) =>
    v === null || v === undefined || (typeof v === 'string' && (v.trim() === '' || v.trim() === '—' || v.trim() === '-')) || (Array.isArray(v) && v.length === 0)
  const pageData = tabKind ? pages[`${tabKind}:${tabPage}`] : null
  const pageRows = pageData?.rows ?? []
  const pageTotal = pageData?.total ?? counts[tabKind === 'sync-log' ? 'sync_log' : tabKind] ?? 0
  const pageIsLoading = tabKind ? !!pageLoading[`${tabKind}:${tabPage}`] : false
  const pageErr = tabKind ? pageError[`${tabKind}:${tabPage}`] : ''
  // Database design, page-local counts and filters (see state note).
  const dbPageMatched = pageRows.filter((t) => t.stage === 'matched').length
  const dbPageNew = pageRows.filter((t) => t.stage === 'new').length
  const dbFilterActive = dbStage !== 'all' || dbQuery.trim() !== ''
  const dbFilteredRows = pageRows
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => {
      if (dbStage !== 'all' && t.stage !== dbStage) return false
      const q = dbQuery.trim().toLowerCase()
      if (!q) return true
      return [t.contract_ref, t.buyer, t.seller, t.commodity, t.disport].join(' ').toLowerCase().includes(q)
    })

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

  const onOpenDetail = async (trade) => {
    setDetail({ trade, loading: true, full: null, error: '' })
    try {
      const full = await fetchTradeDetail(token, project.id, trade.id)
      setDetail({ trade, loading: false, full, error: '' })
    } catch (err) {
      setDetail({ trade, loading: false, full: null, error: err.message || 'Could not load this trade.' })
    }
  }

  const onViewLongText = async (trade, col) => {
    try {
      const full = await fetchTradeDetail(token, project.id, trade.id)
      setRawMessage({
        ref: full.full_data?.Mercancia_Contract_ref || full.contract_ref || '',
        column: col,
        text: full.full_data?.[col] || '',
      })
    } catch (err) {
      setRawMessage({ ref: trade.contract_ref || '', column: col, text: '' })
    }
  }

  const detailFields = () => {
    if (!detail?.full) return []
    const fd = detail.full.full_data
    if (fd && typeof fd === 'object' && !Array.isArray(fd)) {
      const cols = databaseColumns.length > 0 ? databaseColumns : [...TRADESDB_SHEET_COLUMNS, ...Object.keys(fd).filter((c) => !TRADESDB_SHEET_COLUMNS.includes(c))]
      return cols.map((col) => ({ col, value: fd[col] }))
    }
    return SLIM_DB_COLUMNS.map(([h, field]) => ({ col: h, value: detail.full[field] }))
  }
  const detailVisibleFields = detailFields().filter((f) => showEmptyColumns || !isEmptyCellValue(f.value))
  const detailEmptyCount = detailFields().length - detailFields().filter((f) => !isEmptyCellValue(f.value)).length

  const wide = true
  const panelTabs = [
    ['queue', 'Queue'],
    ['stages', 'Stages'],
    ['latest', 'Latest'],
    ['database', 'Database view'],
    ['references', 'References'],
    ['notes', 'Notes'],
    ['log', 'Sync log'],
  ]
  // Tab count badges, from the live dashboard API only, matching the
  // Desktop/Phone mock (Queue, Database, References, Notes, Sync log
  // carry a count; Stages and Latest do not). Never the mock's old
  // counts: 210 trades, 5 queued, 13 sync are NOT used, the live
  // counts above are. Hidden while the dashboard is still loading.
  const tabBadge = (key) => {
    if (!data) return null
    const v = { queue: counts.queue, database: counts.trades, references: counts.references, notes: counts.notes, log: counts.sync_log }[key]
    return v == null ? null : Number(v).toLocaleString('en-US')
  }
  return (
    <main className={`project-page${wide ? ' project-page-wide' : ''} project-page-${tab}${panelOpen ? ' project-panel-open' : ''}`} aria-label={`Dashboard for ${project.name}`}>
      <div className="project-topbar" aria-label="Dashboard top bar">
        <button type="button" className="project-menu-btn" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen} aria-label={panelOpen ? 'Close dashboard menu' : 'Open dashboard menu'}>
          ☰ Menu
        </button>
        <button type="button" className="project-topbar-chats" onClick={goToChats} aria-label="Back to chats">
          Chats
        </button>
      </div>
      {panelOpen ? (
        <>
          <div className="project-panel-backdrop" onClick={closePanel} role="presentation" aria-hidden="true" />
          <div className="project-panel" role="dialog" aria-modal="true" aria-label="Dashboard menu">
            <div className="project-panel-head">
              <strong>Menu</strong>
              <button ref={panelCloseRef} type="button" className="project-panel-close" onClick={closePanel} aria-label="Close dashboard menu">
                ✕
              </button>
            </div>
            <button type="button" className="project-panel-item" onClick={goToChats}>
              Chats
            </button>
            <button type="button" className="project-panel-item" onClick={goToProjects}>
              &lsaquo; Back to projects
            </button>
            <div className="project-panel-divider" role="presentation" />
            {panelTabs.map(([key, label]) => (
              <button key={key} type="button" className={`project-panel-item project-panel-tab ${tab === key ? 'active' : ''}`} onClick={() => goToTab(key)} aria-selected={tab === key}>
                {label}{tabBadge(key) != null ? <span className="project-tab-badge">{tabBadge(key)}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {/* No Back buttons in the hero: the persistent Chats / Projects
          switch above the dashboard (desktop) and the Menu / Chats
          top bar plus side panel (iPhone) already do exactly the same
          navigation, so a second pair here was a duplicate. onBack /
          onBackToChats are still used by the side panel below. */}
      <header className="project-header db-hero">
        <svg className="db-hero-rings" aria-hidden="true" width="420" height="420" viewBox="0 0 420 420" fill="none">
          <circle cx="210" cy="210" r="190" stroke="#fff" stroke-width="28" />
          <circle cx="210" cy="210" r="115" stroke="#fff" stroke-width="28" />
          <circle cx="210" cy="210" r="42" fill="#fff" />
        </svg>
        <div className="db-hero-title">
          <div className="db-hero-icon" aria-hidden="true">
            <svg width="36" height="36" viewBox="0 0 46 46" fill="none">
              <circle cx="23" cy="23" r="20" stroke="#0866FF" stroke-width="5" />
              <circle cx="23" cy="23" r="11" stroke="#4DA3FF" stroke-width="5" />
              <circle cx="23" cy="23" r="3.5" fill="#0866FF" />
            </svg>
          </div>
          <h1>{project.name}</h1>
        </div>
        {loading ? (
          <p className="db-hero-muted">Loading counts…</p>
        ) : error ? (
          <p className="project-empty">{error}</p>
        ) : (
          <div className="db-stats" aria-label="Project counts">
            <div className="db-stat"><span className="db-stat-label">Trades</span><span className="db-stat-value">{counts.trades ?? 0}</span></div>
            <div className="db-stat"><span className="db-stat-label">References</span><span className="db-stat-value">{counts.references ?? 0}</span></div>
            <div className="db-stat"><span className="db-stat-label">Notes</span><span className="db-stat-value">{counts.notes ?? 0}</span></div>
            <div className="db-stat db-stat--accent"><span className="db-stat-label">Queued</span><span className="db-stat-value">{counts.queue ?? 0}</span></div>
            <div className="db-stat"><span className="db-stat-label">Sync log entries</span><span className="db-stat-value">{counts.sync_log ?? 0}</span></div>
          </div>
        )}
      </header>
      <nav className="project-tabs" aria-label="Dashboard sections">
        {[
          ['queue', 'Queue'],
          ['stages', 'Stages'],
          ['latest', 'Latest'],
          ['database', 'Database view'],
          ['references', 'References'],
          ['notes', 'Notes'],
          ['log', 'Sync log'],
        ].map(([key, label]) => (
          <button key={key} className={`project-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} aria-selected={tab === key}>
            {label}{tabBadge(key) != null ? <span className="project-tab-badge">{tabBadge(key)}</span> : null}
          </button>
        ))}
      </nav>

      {error ? (
        <p className="project-empty">{error}</p>
      ) : (
        <>
          {tab === 'queue' && (
            <section aria-label="Queue">
              <h2>Queue</h2>
              {pageIsLoading ? (
                <p className="project-empty">Loading queue…</p>
              ) : pageErr ? (
                <p className="project-empty">{pageErr}</p>
              ) : pageRows.length === 0 ? (
                <p className="project-empty">No trades queued yet. The one-trader test will land here.</p>
              ) : (
                <>
                  <ul className="project-list">
                    {pageRows.map((q, i) => (
                      <li key={q.id}>
                        <div className="project-row">
                          <span className="project-row-name">
                            {tabPage * PAGE_SIZE + i + 1}. {show(q.subject || q.message_id)}
                          </span>
                          <span className="muted">
                            {show(q.sender)} · {q.status} · {when(q.created_at)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Pager page={tabPage} total={pageTotal} onPage={(p) => setPageNums((prev) => ({ ...prev, queue: p }))} />
                </>
              )}
            </section>
          )}

          {tab === 'stages' && (
            <section aria-label="Stages">
              <h2>Stages</h2>
              {loading ? (
                <p className="muted">Loading counts…</p>
              ) : (
                <>
                  <div className="project-stage-grid">
                    {STAGES.map((s) => (
                      <article key={s.key} className="project-stage-card">
                        <div className="project-stage-count">{stageCounts[s.key] ?? 0}</div>
                        <h3>{s.label}</h3>
                        <p className="muted">{s.text}</p>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {tab === 'latest' && (
            <section aria-label="Latest trades">
              <h2>Latest</h2>
              {syncMessage ? <p className="project-empty">{syncMessage}</p> : null}
              {syncError ? <p className="project-empty">{syncError}</p> : null}
              {loading ? (
                <p className="project-empty">Loading latest trades…</p>
              ) : !Array.isArray(data?.latestTrades) || data.latestTrades.length === 0 ? (
                <p className="project-empty">No latest trades yet.</p>
              ) : (
                <>
                  <div className="project-table-wrap">
                    <table className="project-table">
                      <thead>
                        <tr>
                          <th className="sn-col">S/N</th>
                          {SLIM_DB_COLUMNS.map(([h]) => (
                            <th key={h}>{h}</th>
                          ))}
                          <th>Details</th>
                          <th>Sync</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.latestTrades.map((t, i) => (
                          <tr key={t.id}>
                            <td className="sn-col">{i + 1}</td>
                            {SLIM_DB_COLUMNS.map(([h, field]) => (
                              <td key={h}>{field === 'stage' ? show(t.stage) : show(t[field])}</td>
                            ))}
                            <td>
                              <button type="button" className="raw-message-btn" onClick={() => onOpenDetail(t)} aria-label={`View full details for ${t.contract_ref || `trade ${t.id}`}`}>
                                Details
                              </button>
                            </td>
                            <td>
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
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="project-card-list" aria-label="Latest trade cards">
                    {data.latestTrades.map((t, i) => (
                      <article key={t.id} className="project-card">
                        <div className="project-card-head">
                          <span className="project-card-sn">{i + 1}</span>
                          <strong className="project-card-title">{show(t.contract_ref)}</strong>
                          <span className="project-card-stage">{show(t.stage)}</span>
                        </div>
                        <p className="project-card-sub">{show(t.commodity)}{t.quantity != null ? ` · ${show(t.quantity)}` : ''}{t.disport ? ` · ${show(t.disport)}` : ''}</p>
                        <dl className="project-card-fields">
                          <div><dt>Buyer</dt><dd>{show(t.buyer)}</dd></div>
                          <div><dt>Seller</dt><dd>{show(t.seller)}</dd></div>
                          <div><dt>Disport</dt><dd>{show(t.disport)}</dd></div>
                        </dl>
                        <div className="project-card-actions">
                          <button type="button" className="raw-message-btn project-card-primary" onClick={() => onOpenDetail(t)}>Details</button>
                          <button type="button" className="raw-message-btn project-card-primary" disabled={syncBusyId === t.id || pendingSyncIds.has(t.id) || syncedIds.has(t.id)} onClick={() => onRequestSync(t)}>{syncedIds.has(t.id) ? 'Synced' : pendingSyncIds.has(t.id) ? 'Sync requested' : syncBusyId === t.id ? 'Requesting…' : 'Sync'}</button>
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {tab === 'database' && (
            <section aria-label="Database view" className="db-panel">
              <div className="db-panel-head">
                <div>
                  <h2>Database view</h2>
                  <p className="muted">All trades, newest at the bottom</p>
                </div>
                <div className="db-tools">
                  <label className="db-search">
                    <span className="sr-only">Search trades on this page</span>
                    <input type="search" value={dbQuery} onChange={(e) => setDbQuery(e.target.value)} placeholder="Search ref, party, commodity" autoComplete="off" aria-label="Search trades on this page" />
                  </label>
                  <button type="button" className="db-toggle" onClick={() => setShowEmptyColumns((v) => !v)} aria-label={showEmptyColumns ? 'Hide empty columns' : 'Show empty columns'}>
                    {showEmptyColumns ? 'Hide empty columns' : `Show ${serverEmptyColumns.length} empty columns`}
                  </button>
                </div>
              </div>
              {syncMessage ? <p className="project-empty">{syncMessage}</p> : null}
              {syncError ? <p className="project-empty">{syncError}</p> : null}
              {data?.hasFullData && serverEmptyColumns.length > 0 ? (
                <p className="muted db-empty-note">
                  {showEmptyColumns ? `${serverEmptyColumns.length} empty columns shown` : `${serverEmptyColumns.length} empty columns hidden`}
                </p>
              ) : null}
              <div className="db-filters" role="group" aria-label="Filter by stage">
                <span className="db-filters-label">Stage</span>
                {[
                  ['all', 'All', pageRows.length],
                  ['matched', 'Matched', dbPageMatched],
                  ['new', 'New', dbPageNew],
                ].map(([key, label, count]) => (
                  <button key={key} type="button" className="db-chip" aria-pressed={dbStage === key} onClick={() => setDbStage(key)}>
                    {label} · {count}
                  </button>
                ))}
              </div>
              {pageRows.length > 0 ? (
                <div className="db-mix">
                  <div className="db-mix-meta"><span>Stage mix on this page</span><span>{dbPageMatched} matched · {dbPageNew} new</span></div>
                  <div className="db-mix-bar" role="img" aria-label={`${dbPageMatched} matched, ${dbPageNew} new on this page`}>
                    <div className="db-mix-matched" style={{ width: `${(dbPageMatched / pageRows.length) * 100}%` }} />
                    <div className="db-mix-new" style={{ width: `${(dbPageNew / pageRows.length) * 100}%` }} />
                  </div>
                </div>
              ) : null}
              {dbFilterActive ? <p className="muted db-filter-note">{dbFilteredRows.length} of {pageRows.length} on this page match this filter. Search and stage filter apply to this page only, not the whole collection.</p> : null}
              {pageIsLoading ? (
                <p className="project-empty">Loading trades…</p>
              ) : pageErr ? (
                <p className="project-empty">{pageErr}</p>
              ) : (
                <>
                  <div className="project-table-wrap">
                    <table className="project-table">
                      <thead>
                        <tr>
                          <th className="sn-col">S/N</th>
                          {SLIM_DB_COLUMNS.map(([h]) => (
                            <th key={h}>{h}</th>
                          ))}
                          {LONG_TEXT_COLUMNS.filter((col) => showEmptyColumns || !serverEmptyColumns.includes(col)).map((col) => (
                            <th key={col}>{col}</th>
                          ))}
                          <th>Details</th>
                          <th>Sync</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dbFilteredRows.length === 0 ? (
                          <tr>
                            <td colSpan={SLIM_DB_COLUMNS.length + LONG_TEXT_COLUMNS.filter((col) => showEmptyColumns || !serverEmptyColumns.includes(col)).length + 3} className="project-empty">
                              {pageRows.length === 0 ? 'No trades saved yet.' : 'No trades on this page match these filters.'}
                            </td>
                          </tr>
                        ) : (
                          dbFilteredRows.map(({ t, idx: i }) => (
                            <tr key={t.id}>
                              <td className="sn-col">{tabPage * PAGE_SIZE + i + 1}</td>
                              <td><span className="db-ref">{show(t.contract_ref)}</span></td>
                              <td><PartyCell name={t.buyer} /></td>
                              <td><PartyCell name={t.seller} /></td>
                              <td>{show(t.commodity)}</td>
                              <td className="db-num">{show(t.quantity)}</td>
                              <td>{show(t.disport)}</td>
                              <td><StagePill stage={t.stage} /></td>
                              {LONG_TEXT_COLUMNS.filter((col) => showEmptyColumns || !serverEmptyColumns.includes(col)).map((col) => (
                                <td key={col} className="raw-message-cell">
                                  <button
                                    type="button"
                                    className="raw-message-btn"
                                    onClick={() => onViewLongText(t, col)}
                                    aria-label={`View ${col} for ${t.contract_ref || `trade ${t.id}`}`}
                                  >
                                    View
                                  </button>
                                </td>
                              ))}
                              <td>
                                <button type="button" className="raw-message-btn" onClick={() => onOpenDetail(t)} aria-label={`View full details for ${t.contract_ref || `trade ${t.id}`}`}>
                                  Details
                                </button>
                              </td>
                              <td>
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
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="project-card-list" aria-label="Database cards">
                    {dbFilteredRows.map(({ t, idx: i }) => (
                      <article key={t.id} className="project-card">
                        <div className="project-card-head">
                          <span className="project-card-sn">{tabPage * PAGE_SIZE + i + 1}</span>
                          <strong className="project-card-title">{show(t.contract_ref)}</strong>
                          <span className="project-card-stage"><StagePill stage={t.stage} /></span>
                        </div>
                        <p className="project-card-sub">{show(t.commodity)}{t.quantity != null ? ` · ${show(t.quantity)}` : ''}{t.disport ? ` · ${show(t.disport)}` : ''}</p>
                        <dl className="project-card-fields">
                          <div><dt>Buyer</dt><dd><PartyCell name={t.buyer} /></dd></div>
                          <div><dt>Seller</dt><dd><PartyCell name={t.seller} /></dd></div>
                          <div><dt>Disport</dt><dd>{show(t.disport)}</dd></div>
                        </dl>
                        <div className="project-card-actions">
                          {LONG_TEXT_COLUMNS.filter((col) => showEmptyColumns || !serverEmptyColumns.includes(col)).map((col) => (
                            <button key={col} type="button" className="raw-message-btn" onClick={() => onViewLongText(t, col)} aria-label={`View ${col} for ${t.contract_ref || `trade ${t.id}`}`}>View {col}</button>
                          ))}
                          <button type="button" className="raw-message-btn project-card-primary" onClick={() => onOpenDetail(t)}>Details</button>
                          <button type="button" className="raw-message-btn project-card-primary" disabled={syncBusyId === t.id || pendingSyncIds.has(t.id) || syncedIds.has(t.id)} onClick={() => onRequestSync(t)}>{syncedIds.has(t.id) ? 'Synced' : pendingSyncIds.has(t.id) ? 'Sync requested' : syncBusyId === t.id ? 'Requesting…' : 'Sync'}</button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <Pager page={tabPage} total={pageTotal} onPage={(p) => setPageNums((prev) => ({ ...prev, database: p }))} />
                </>
              )}
            </section>
          )}

          {tab === 'references' && (
            <section aria-label="References">
              <h2>References</h2>
              {pageIsLoading ? (
                <p className="project-empty">Loading references…</p>
              ) : pageErr ? (
                <p className="project-empty">{pageErr}</p>
              ) : (
                <>
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
                        {pageRows.length === 0 ? (
                          <tr>
                            <td colSpan={REFERENCE_COLUMNS.length + 1} className="project-empty">
                              No references saved yet.
                            </td>
                          </tr>
                        ) : (
                          pageRows.map((r, i) => (
                            <tr key={r.id}>
                              <td className="sn-col">{tabPage * PAGE_SIZE + i + 1}</td>
                              {REFERENCE_COLUMNS.map(([h, field]) => (
                                <td key={h}>{field === 'updated_at' ? when(r[field]) : show(r[field])}</td>
                              ))}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="project-card-list" aria-label="Reference cards">
                    {pageRows.map((r, i) => (
                      <article key={r.id} className="project-card">
                        <div className="project-card-head">
                          <span className="project-card-sn">{tabPage * PAGE_SIZE + i + 1}</span>
                          <strong className="project-card-title">{show(r.shadow_ref)}</strong>
                        </div>
                        <dl className="project-card-fields">
                          <div><dt>Live refs</dt><dd>{show(r.live_refs)}</dd></div>
                          <div><dt>External refs</dt><dd>{show(r.external_refs)}</dd></div>
                          <div><dt>Fingerprint</dt><dd className="project-card-clamp">{show(r.fingerprint)}</dd></div>
                          <div><dt>Updated</dt><dd>{when(r.updated_at)}</dd></div>
                        </dl>
                      </article>
                    ))}
                  </div>
                  <Pager page={tabPage} total={pageTotal} onPage={(p) => setPageNums((prev) => ({ ...prev, references: p }))} />
                </>
              )}
            </section>
          )}

          {tab === 'notes' && (
            <section aria-label="Notes">
              <h2>Notes</h2>
              {pageIsLoading ? (
                <p className="project-empty">Loading notes…</p>
              ) : pageErr ? (
                <p className="project-empty">{pageErr}</p>
              ) : (
                <>
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
                        {pageRows.length === 0 ? (
                          <tr>
                            <td colSpan={NOTE_COLUMNS.length + 1} className="project-empty">
                              No notes saved yet.
                            </td>
                          </tr>
                        ) : (
                          pageRows.map((n, i) => (
                            <tr key={n.id}>
                              <td className="sn-col">{tabPage * PAGE_SIZE + i + 1}</td>
                              {NOTE_COLUMNS.map(([h, field]) =>
                                NOTE_LONG_TEXT_FIELDS.includes(field) ? (
                                  <td key={h} className="raw-message-cell">
                                    <button
                                      type="button"
                                      className="raw-message-btn"
                                      onClick={() =>
                                        setRawMessage({
                                          ref: `Note ${n.id}`,
                                          column: h,
                                          text: n[field] || '',
                                        })
                                      }
                                      aria-label={`View ${h} for note ${n.id}`}
                                    >
                                      View
                                    </button>
                                  </td>
                                ) : (
                                  <td key={h}>{field === 'created_at' ? when(n[field]) : show(n[field])}</td>
                                )
                              )}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="project-card-list" aria-label="Note cards">
                    {pageRows.map((n, i) => (
                      <article key={n.id} className="project-card">
                        <div className="project-card-head">
                          <span className="project-card-sn">{tabPage * PAGE_SIZE + i + 1}</span>
                          <strong className="project-card-title">Note {n.id}</strong>
                          <span className="project-card-stage">{show(n.priority)}</span>
                        </div>
                        <dl className="project-card-fields">
                          <div><dt>Subject</dt><dd className="project-card-clamp">{show(n.subject)}</dd></div>
                          <div><dt>Summary</dt><dd className="project-card-clamp">{show(n.summary)}</dd></div>
                          <div><dt>Linked trade</dt><dd>{show(n.trade_id)}</dd></div>
                          <div><dt>Action required</dt><dd>{show(n.action_required)}</dd></div>
                          <div><dt>Created</dt><dd>{when(n.created_at)}</dd></div>
                        </dl>
                        <div className="project-card-actions">
                          {NOTE_LONG_TEXT_FIELDS.map((field) => {
                            const h = NOTE_COLUMNS.find(([, f]) => f === field)?.[0] || field
                            return (
                              <button key={field} type="button" className="raw-message-btn" onClick={() => setRawMessage({ ref: `Note ${n.id}`, column: h, text: n[field] || '' })} aria-label={`View ${h} for note ${n.id}`}>View {h}</button>
                            )
                          })}
                        </div>
                      </article>
                    ))}
                  </div>
                  <Pager page={tabPage} total={pageTotal} onPage={(p) => setPageNums((prev) => ({ ...prev, notes: p }))} />
                </>
              )}
            </section>
          )}

          {tab === 'log' && (
            <section aria-label="Sync log">
              <h2>Sync log</h2>
              {pageIsLoading ? (
                <p className="project-empty">Loading sync log…</p>
              ) : pageErr ? (
                <p className="project-empty">{pageErr}</p>
              ) : pageRows.length === 0 ? (
                <p className="project-empty">No log entries yet.</p>
              ) : (
                <>
                  <ul className="project-list">
                    {pageRows.map((s, i) => (
                      <li key={s.id}>
                        <div className="project-row">
                          <span className="project-row-name">
                            {tabPage * PAGE_SIZE + i + 1}. {show(s.target)} · {s.target === 'sync_request' ? 'requested' : s.success ? 'ok' : 'failed'} · trade {s.trade_id}
                          </span>
                          <span className="muted">
                            {show(s.failure_reason)} · {when(s.created_at)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Pager page={tabPage} total={pageTotal} onPage={(p) => setPageNums((prev) => ({ ...prev, log: p }))} />
                </>
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
            aria-label={`${rawMessage.column && rawMessage.column !== 'raw_message' ? rawMessage.column : 'Raw message'} for ${rawMessage.ref}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="raw-message-dialog-head">
              <strong>
                {rawMessage.column && rawMessage.column !== 'raw_message'
                  ? `${rawMessage.column}: ${rawMessage.ref}`
                  : rawMessage.ref
                    ? `Raw message: ${rawMessage.ref}`
                    : 'Raw message'}
              </strong>
              <button type="button" className="raw-message-close" onClick={() => setRawMessage(null)} aria-label="Close">
                Close
              </button>
            </div>
            <div className="raw-message-dialog-body">
              {rawMessage.text || `No text stored for ${rawMessage.column || 'raw_message'}.`}
            </div>
          </div>
        </div>
      )}
      {detail && (
        <div className="raw-message-backdrop" onClick={() => setDetail(null)} role="presentation">
          <div className="raw-message-dialog" role="dialog" aria-modal="true" aria-label={`Full details for ${detail.trade.contract_ref || `trade ${detail.trade.id}`}`} onClick={(e) => e.stopPropagation()}>
            <div className="raw-message-dialog-head">
              <strong>
                Full details: {detail.trade.contract_ref || `trade ${detail.trade.id}`} · {detail.trade.commodity || ''} {detail.trade.quantity != null ? detail.trade.quantity : ''}
              </strong>
              <button type="button" className="raw-message-close" onClick={() => setDetail(null)} aria-label="Close">
                Close
              </button>
            </div>
            <div className="raw-message-dialog-body">
              {detail.loading ? (
                <p className="muted">Loading full trade data…</p>
              ) : detail.error ? (
                <p className="project-empty">{detail.error}</p>
              ) : detailEmptyCount > 0 ? (
                <>
                  <p className="muted">
                    {showEmptyColumns ? `${detailEmptyCount} empty fields shown` : `${detailEmptyCount} empty fields hidden`}{' '}
                    <button type="button" className="raw-message-btn" onClick={() => setShowEmptyColumns((v) => !v)}>
                      {showEmptyColumns ? 'Hide empty fields' : 'Show empty fields'}
                    </button>
                  </p>
                  <dl className="project-detail-list">
                    {detailVisibleFields.map((f) => (
                      <div key={f.col} className="project-detail-row">
                        <dt>{f.col}</dt>
                        <dd>{show(f.value)}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <dl className="project-detail-list">
                  {detailVisibleFields.map((f) => (
                    <div key={f.col} className="project-detail-row">
                      <dt>{f.col}</dt>
                      <dd>{show(f.value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
