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

async function apiFetch(token, path, method = 'GET', bodyJson, timeoutMs) {
  if (!token) throw new Error('You are not signed in. Sign in again to open projects.')
  let controller = null
  let timer = null
  if (timeoutMs && typeof AbortController !== 'undefined') {
    controller = new AbortController()
    timer = setTimeout(() => controller.abort(), timeoutMs)
  }
  let res
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: bodyJson ? JSON.stringify(bodyJson) : undefined,
      signal: controller ? controller.signal : undefined,
    })
  } catch (err) {
    if (controller && controller.signal.aborted) throw new Error('Project request timed out. Check your connection and retry.')
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
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
// Returns { rows, total }. Page fetches carry a 30-second timeout so
// a hung page load always resolves to loaded or error, never to a
// permanently disabled "Loading more…" footer (see LoadMoreFooter).
export async function fetchPage(token, projectId, kind, page) {
  const offset = page * 50
  const slim = kind === 'trades' ? '&slim=1' : ''
  const data = await apiFetch(token, `/api/projects/${projectId}/${kind}?limit=50&offset=${offset}${slim}`, 'GET', undefined, 30000)
  const key = kind === 'sync-log' ? 'sync_log' : kind
  return { rows: Array.isArray(data[key]) ? data[key] : [], total: typeof data.total === 'number' ? data.total : 0 }
}

// Same endpoint, explicit offset/limit: the only way to serve a
// newest-first thread list without a server change, because the
// subcollection GET orders by id ascending and has no descending
// option. Thread tabs (Database, References, Notes) load chunk 0 from
// the END of the collection (offset total - 50) and reverse it, then
// chunk 1, and so on, so the list reads newest first and load-more
// appends older rows below. No new endpoint, no data change. Notes
// load chunks stay 50 rows: the 100-per-page change was corrected
// away, and 50 is the loading chunk, not a page the user navigates.
export async function fetchPageAt(token, projectId, kind, offset, limit = 50) {
  const slim = kind === 'trades' ? '&slim=1' : ''
  const data = await apiFetch(token, `/api/projects/${projectId}/${kind}?limit=${limit}&offset=${offset}${slim}`, 'GET', undefined, 30000)
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
const SIDEBAR_TABS = [
  ['dashboard', 'Dashboard'],
  ['queue', 'Queue'],
  ['stages', 'Stages'],
  ['latest', 'Latest'],
  ['database', 'Database view'],
  ['references', 'References'],
  ['notes', 'Notes'],
  ['log', 'Sync log'],
]

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

// Load-more footer, no pager. Two stuck-state fixes: (1) the sentinel
// cannot fire twice for the same loaded count while a load is in
// flight (firedRef + loadingRef), so a page is never skipped by a
// double increment; (2) a failed page load shows its error with an
// enabled Retry button that re-requests the SAME page, instead of a
// disabled "Loading more…" forever or a Load more tap that silently
// skips the failed page. Page fetches also time out after 30 seconds
// (see fetchPage), so loading always resolves to loaded or error.
function LoadMoreFooter({ loaded, total, loading, error, onLoadMore, onRetry }) {
  const sentinelRef = useRef(null)
  const firedRef = useRef(false)
  const loadingRef = useRef(loading)
  loadingRef.current = loading
  const hasMore = loaded < total
  useEffect(() => {
    firedRef.current = false
  }, [loaded])
  useEffect(() => {
    if (!hasMore || loading || error) return undefined
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loadingRef.current && !firedRef.current) {
          firedRef.current = true
          onLoadMore()
        }
      },
      { root: null, rootMargin: '200px', threshold: 0 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loading, error, onLoadMore, loaded])
  return (
    <div className="project-loadmore" role="navigation" aria-label="More rows">
      <span className="muted">
        Showing {loaded} of {total}
      </span>
      {error ? (
        <>
          <p className="project-loadmore-error" role="alert">
            Could not load more rows: {error}
          </p>
          <button type="button" className="project-pager-btn" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : hasMore ? (
        <>
          <div ref={sentinelRef} aria-hidden="true" />
          <button type="button" className="project-pager-btn" disabled={loading} onClick={onLoadMore}>
            {loading ? 'Loading more…' : 'Load more'}
          </button>
        </>
      ) : null}
    </div>
  )
}

// Small error note with a retry for a first-page load failure, used
// by the paged tabs. The retry re-requests the same page, never the
// next one, so no rows are skipped.
function PageErrorNote({ error, onRetry }) {
  return (
    <div className="project-loadmore-error-wrap" role="alert">
      <p className="project-empty">{error}</p>
      <button type="button" className="project-pager-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

export function ProjectDashboard({ project, token, onBack, onBackToChats }) {
  const [tab, setTab] = useState('dashboard')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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
  const [pageNums, setPageNums] = useState({ dashboard: 0, queue: 0, stages: 0, latest: 0, database: 0, references: 0, notes: 0, log: 0 })
  const [pageLoading, setPageLoading] = useState({})
  const [pageError, setPageError] = useState({})
  // Retry counter per page key: bumping it re-runs the page effect
  // for the SAME page after a failure (see retryCurrentPage).
  const [pageAttempts, setPageAttempts] = useState({})
  // Newest-first thread state (Database, References, Notes only):
  // totals learned from a 1-row probe, chunks keyed rev, each chunk
  // stored already reversed (newest first within the chunk).
  const [threadTotals, setThreadTotals] = useState({})
  const [threadChunks, setThreadChunks] = useState({})
  // Sync log combined view: queue rows loaded through the existing
  // queue endpoint only, in 50-row chunks, never created here.
  const [logQueue, setLogQueue] = useState([])
  const [logQueueTotal, setLogQueueTotal] = useState(null)
  const [logQueueLoading, setLogQueueLoading] = useState(false)
  const [logQueueError, setLogQueueError] = useState('')
  const [logQueuePage, setLogQueuePage] = useState(0)
  const [syncDetail, setSyncDetail] = useState(null)
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
  const [sidebarQuery, setSidebarQuery] = useState('')
  const [dbStage, setDbStage] = useState('all')

  useEffect(() => {
    if (!rawMessage && !detail && !panelOpen && !syncDetail) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setRawMessage(null)
        setDetail(null)
        setPanelOpen(false)
        setSyncDetail(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rawMessage, detail, panelOpen, syncDetail])

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
    setPageNums({ dashboard: 0, queue: 0, stages: 0, latest: 0, database: 0, references: 0, notes: 0, log: 0 })
    setPageError({})
    setPageAttempts({})
    setThreadTotals({})
    setThreadChunks({})
    setLogQueue([])
    setLogQueueTotal(null)
    setLogQueueLoading(false)
    setLogQueueError('')
    setLogQueuePage(0)
    setSyncDetail(null)
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
  const isThreadTab = tab === 'database' || tab === 'references' || tab === 'notes'
  // Ascending tabs only (Queue, Sync log). Thread tabs use the effect below.
  useEffect(() => {
    if (!tabKind || isThreadTab) return undefined
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
  }, [tab, tabKind, tabPage, token, project.id, pages, isThreadTab, pageAttempts])
  // Newest-first thread loading (Database, References, Notes). The
  // probe learns the total, then chunk c loads from the end:
  // offset total - (c + 1) * 50, reversed, so chunk 0 is the newest
  // 50 rows. Appending a chunk never renumbers rows already shown.
  useEffect(() => {
    if (!tabKind || !isThreadTab) return undefined
    const kind = tabKind
    const total = threadTotals[kind]
    if (total == null) {
      const key = `${kind}:rev:probe`
      if (pageLoading[key]) return undefined
      let cancelled = false
      setPageLoading((prev) => ({ ...prev, [key]: true }))
      setPageError((prev) => ({ ...prev, [key]: '' }))
      fetchPageAt(token, project.id, kind, 0, 1)
        .then((res) => {
          if (!cancelled) setThreadTotals((prev) => ({ ...prev, [kind]: res.total }))
        })
        .catch((err) => {
          if (!cancelled) setPageError((prev) => ({ ...prev, [key]: err.message || 'Could not load this list.' }))
        })
        .finally(() => {
          if (!cancelled) setPageLoading((prev) => ({ ...prev, [key]: false }))
        })
      return () => {
        cancelled = true
      }
    }
    const key = `${kind}:rev:${tabPage}`
    if (threadChunks[key]) return undefined
    const limit = Math.min(50, total - tabPage * 50)
    if (limit <= 0) return undefined
    const offset = Math.max(0, total - (tabPage + 1) * 50)
    let cancelled = false
    setPageLoading((prev) => ({ ...prev, [key]: true }))
    setPageError((prev) => ({ ...prev, [key]: '' }))
    fetchPageAt(token, project.id, kind, offset, limit)
      .then((res) => {
        if (!cancelled) setThreadChunks((prev) => ({ ...prev, [key]: { rows: [...res.rows].reverse(), total: res.total } }))
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
  }, [tab, tabKind, tabPage, token, project.id, isThreadTab, threadTotals, threadChunks, pageAttempts])
  // Sync log tab: queue rows for the combined view, through the
  // existing queue endpoint only, one 50-row chunk at a time, until
  // the queue total is reached. A queue failure never blocks the
  // sync-log rows; it shows its own error with its own retry.
  useEffect(() => {
    if (tab !== 'log') return undefined
    if (logQueueTotal != null && logQueue.length >= logQueueTotal) return undefined
    if (logQueueLoading || logQueueError) return undefined
    let cancelled = false
    setLogQueueLoading(true)
    fetchPage(token, project.id, 'queue', logQueuePage)
      .then((res) => {
        if (cancelled) return
        setLogQueue((prev) => [...prev, ...res.rows])
        setLogQueueTotal(res.total)
        if (logQueue.length + res.rows.length < res.total) setLogQueuePage((p) => p + 1)
      })
      .catch((err) => {
        if (!cancelled) setLogQueueError(err.message || 'Could not load queue items.')
      })
      .finally(() => {
        if (!cancelled) setLogQueueLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, token, project.id, logQueuePage, logQueueTotal, logQueueLoading, logQueueError, logQueue])

  const counts = data?.counts ?? {}
  const stageCounts = data?.stageCounts ?? {}
  const stageTotal = STAGES.reduce((n, st) => n + (Number(stageCounts[st.key]) || 0), 0)
  const stageShare = (key) => (stageTotal > 0 ? `${((Number(stageCounts[key]) || 0) / stageTotal * 100).toFixed(1)}%` : '0%')
  const pendingSyncIds = new Set(data?.pendingSyncIds ?? [])
  const syncedIds = new Set(data?.syncedIds ?? [])
  const databaseColumns = Array.isArray(data?.databaseColumns) ? data.databaseColumns : []
  const serverEmptyColumns = Array.isArray(data?.emptyColumns) ? data.emptyColumns : []
  const isEmptyCellValue = (v) =>
    v === null || v === undefined || (typeof v === 'string' && (v.trim() === '' || v.trim() === '—' || v.trim() === '-')) || (Array.isArray(v) && v.length === 0)
  const pageData = tabKind ? pages[`${tabKind}:${tabPage}`] : null
  // Infinite scroll (no pager at all, user direction 2026-10-31): all
  // pages loaded so far for this tab are concatenated, in order, so
  // rows beyond the first chunk are reached by scrolling / Load more,
  // not by a Previous/Next pager. pageRows is therefore the loaded
  // rows, not just the current chunk.
  // S/N definition, thread tabs (Database, References, Notes): S/N is
  // the position in the newest-first list, so S/N 1 is the newest row
  // overall (for trades, trade 211 when the total is 211, then 210,
  // 209, and so on). Load-more appends older rows below without
  // renumbering rows already shown. Queue and Sync log keep their
  // previous ascending order; only the three thread tabs are reversed.
  const threadRows = isThreadTab && tabKind
    ? Array.from({ length: tabPage + 1 }, (_, c) => threadChunks[`${tabKind}:rev:${c}`]?.rows ?? []).flat()
    : []
  const pageRows = isThreadTab
    ? threadRows
    : tabKind
      ? Array.from({ length: tabPage + 1 }, (_, p) => pages[`${tabKind}:${p}`]?.rows ?? []).flat()
      : []
  const threadTotal = isThreadTab && tabKind ? threadTotals[tabKind] : null
  const pageTotal = isThreadTab
    ? threadTotal ?? counts[tabKind] ?? 0
    : pageData?.total ?? (tabKind ? pages[`${tabKind}:0`]?.total : null) ?? counts[tabKind === 'sync-log' ? 'sync_log' : tabKind] ?? 0
  const threadPageKey = isThreadTab && tabKind ? `${tabKind}:rev:${tabPage}` : `${tabKind}:${tabPage}`
  const threadProbeKey = isThreadTab && tabKind ? `${tabKind}:rev:probe` : null
  const rawPageIsLoading = tabKind
    ? !!(pageLoading[threadPageKey] || (isThreadTab && threadTotal == null && threadProbeKey && pageLoading[threadProbeKey]))
    : false
  const pageIsLoading = rawPageIsLoading && pageRows.length === 0
  const pageLoadingMore = rawPageIsLoading && pageRows.length > 0
  const pageErr = pageRows.length === 0 && tabKind
    ? pageError[threadPageKey] || (threadProbeKey ? pageError[threadProbeKey] : '') || ''
    : ''
  // Error on the current load-more page only, shown by the footer
  // while the rows already loaded stay visible.
  const pageLoadMoreError = pageRows.length > 0 && tabKind ? pageError[threadPageKey] || '' : ''
  // Retry re-requests the SAME page (or the thread probe, when the
  // total is not known yet); it never advances to the next page, so
  // a failed page cannot be silently skipped.
  const retryCurrentPage = () => {
    const key = isThreadTab && threadTotal == null && threadProbeKey ? threadProbeKey : threadPageKey
    setPageError((prev) => ({ ...prev, [key]: '' }))
    setPageAttempts((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }))
  }
  const retryLogQueue = () => setLogQueueError('')
  // Combined Sync log entries: queue items and sync-log rows in one
  // chronological list, oldest first, ties keep queue-before-sync
  // order (stable sort). Built only from rows already fetched; no
  // row is created, and no sync request is made from this tab.
  const combinedLog = tab === 'log'
    ? [
        ...logQueue.map((q) => ({ kind: 'queue', row: q, time: q.created_at })),
        ...pageRows.map((s) => ({ kind: 'sync', row: s, time: s.created_at })),
      ].sort((a, b) => {
        const ta = a.time ? new Date(a.time).getTime() : 0
        const tb = b.time ? new Date(b.time).getTime() : 0
        return ta - tb
      })
    : []
  const syncDetailFields = (entry) => {
    const row = entry.row
    if (entry.kind === 'sync') {
      const first = [
        ['trade_id', row.trade_id],
        ['target', row.target],
        ['success', row.success ? 'Yes' : 'No'],
        ['failure_reason', row.failure_reason],
        ['created_at', row.created_at],
      ]
      const seen = new Set(first.map(([k]) => k))
      return [...first, ...Object.entries(row).filter(([k]) => !seen.has(k)).map(([k, v]) => [k, v])]
    }
    return Object.entries(row)
  }
  // Database design, page-local counts and filters (see state note).
  const dbPageMatched = pageRows.filter((t) => t.stage === 'matched').length
  const dbPageNew = pageRows.filter((t) => t.stage === 'new').length
  const dbPageExtracted = pageRows.filter((t) => t.stage === 'extracted').length
  const dbPageFinished = pageRows.filter((t) => t.stage === 'finished').length
  const dbPageOther = pageRows.length - dbPageExtracted - dbPageFinished - dbPageMatched - dbPageNew
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
  // Admin rebuild: long-text fields are shown as a labelled section
  // inside Details only, never as table columns. They are already in
  // detailFields() via databaseColumns, so split them out here.
  const DETAIL_LONG_TEXT = ['addendum_notes', 'Notes', 'doc_instructions', 'required_documents', 'additional_information', 'raw_message']
  const detailLongFields = detailFields().filter((f) => DETAIL_LONG_TEXT.includes(f.col))
  const detailOtherFields = detailFields().filter((f) => !DETAIL_LONG_TEXT.includes(f.col))
  const detailLongVisible = detailLongFields.filter((f) => showEmptyColumns || !isEmptyCellValue(f.value))
  const detailOtherVisible = detailOtherFields.filter((f) => showEmptyColumns || !isEmptyCellValue(f.value))

  const wide = true
  // Premium redesign: SIDEBAR_TABS is shared at module level (no local
  // panelTabs copy), so the sidebar, phone panel and pill bar cannot drift.
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
    <main className={`project-page${wide ? ' project-page-wide' : ''} project-page-${tab}${panelOpen ? ' project-panel-open' : ''}${sidebarCollapsed ? ' project-sidebar-collapsed' : ''}`} aria-label={`Dashboard for ${project.name}`}>
      <aside className="admin-sidebar" aria-label="Project navigation">
        <div className="admin-sidebar-brand">
          <span className="admin-sidebar-mark" aria-hidden="true">M</span>
          <span className="admin-sidebar-brand-text"><strong>{project.name}</strong><span className="muted">Trade dashboard</span></span>
        </div>
        <label className="admin-sidebar-search">
          <span className="sr-only">Search sections</span>
          <input type="search" value={sidebarQuery} onChange={(e) => setSidebarQuery(e.target.value)} placeholder="Search sections" autoComplete="off" aria-label="Search sections" />
        </label>
        <p className="admin-sidebar-label">Main menu</p>
        <nav aria-label="Dashboard sections">
          {SIDEBAR_TABS.filter(([, label]) => label.toLowerCase().includes(sidebarQuery.trim().toLowerCase())).map(([key, label]) => (
            <button key={key} type="button" className={`admin-nav-item ${tab === key ? 'active' : ''}`} onClick={() => goToTab(key)} aria-current={tab === key ? 'page' : undefined}>
              <span className="admin-nav-icon" aria-hidden="true">{{ dashboard: '▦', queue: '☰', stages: '◐', latest: '↻', database: '▤', references: '🔗', notes: '✎', log: '⇋' }[key] || '•'}</span>
              <span className="admin-nav-label">{label}</span>
              {tabBadge(key) != null ? <span className="admin-nav-badge">{tabBadge(key)}</span> : null}
            </button>
          ))}
        </nav>
        <p className="admin-sidebar-label">Help</p>
        <div className="admin-sidebar-foot">
          <button type="button" className="admin-nav-item" onClick={goToChats}><span className="admin-nav-icon" aria-hidden="true">≡</span><span className="admin-nav-label">Chats</span></button>
          <button type="button" className="admin-nav-item" onClick={goToProjects}><span className="admin-nav-icon" aria-hidden="true">‹</span><span className="admin-nav-label">Back to projects</span></button>
          <button type="button" className="admin-nav-item admin-sidebar-collapse" onClick={() => setSidebarCollapsed(true)} aria-label="Collapse sidebar"><span className="admin-nav-icon" aria-hidden="true">«</span><span className="admin-nav-label">Collapse sidebar</span></button>
        </div>
      </aside>
      <div className="admin-content">
      {sidebarCollapsed ? (
        <button type="button" className="project-sidebar-restore" onClick={() => setSidebarCollapsed(false)} aria-label="Show sidebar">
          ☰ Menu
        </button>
      ) : null}
      <div className="project-topbar" aria-label="Dashboard top bar">
        <button type="button" className="project-menu-btn" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen} aria-label={panelOpen ? 'Close dashboard menu' : 'Open dashboard menu'}>
          ☰ Menu
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
            {SIDEBAR_TABS.map(([key, label]) => (
              <button key={key} type="button" className={`project-panel-item project-panel-tab ${tab === key ? 'active' : ''}`} onClick={() => goToTab(key)} aria-selected={tab === key}>
                {label}{tabBadge(key) != null ? <span className="project-tab-badge">{tabBadge(key)}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {/* No Back buttons in the hero: the top Chats / Projects buttons
          were removed as duplicates. Chats and Back to projects live
          in the sidebar foot (desktop) and in the side panel (phone),
          reached from the Menu button. onBack / onBackToChats are
          still used by the sidebar foot and the side panel. */}
      {tab === 'dashboard' && (
      <header className="admin-hero premium-hero">
        <div className="premium-hero-main">
          <h1>{project.name}</h1>
          <p className="muted">Scan trades, open details, sync the ones that are ready.</p>
        </div>
        <div className="premium-hero-toolbar" aria-label="Quick navigation">
          <span className="premium-live"><span className="premium-live-dot" aria-hidden="true" />Live counts</span>
          <button type="button" className="premium-toolbar-btn" onClick={() => goToTab('database')}>Database view</button>
          <button type="button" className="premium-toolbar-btn" onClick={() => goToTab('log')}>Sync log</button>
        </div>
        {loading ? (
          <p className="muted">Loading counts…</p>
        ) : error ? (
          <p className="project-empty">{error}</p>
        ) : (
          <div className="admin-kpis" aria-label="Project counts">
            <div className="admin-kpi"><span className="admin-kpi-label">Trades</span><span className="admin-kpi-value">{counts.trades ?? 0}</span><span className="admin-kpi-sub">In the app database</span></div>
            <div className="admin-kpi"><span className="admin-kpi-label">References</span><span className="admin-kpi-value">{counts.references ?? 0}</span><span className="admin-kpi-sub">Matched references</span></div>
            <div className="admin-kpi"><span className="admin-kpi-label">Notes</span><span className="admin-kpi-value">{counts.notes ?? 0}</span><span className="admin-kpi-sub">Linked notes</span></div>
            <div className="admin-kpi"><span className="admin-kpi-label">Queued</span><span className="admin-kpi-value">{counts.queue ?? 0}</span><span className="admin-kpi-sub">Awaiting finish</span></div>
            <div className="admin-kpi"><span className="admin-kpi-label">Sync log entries</span><span className="admin-kpi-value">{counts.sync_log ?? 0}</span><span className="admin-kpi-sub">Requests and results</span></div>
          </div>
        )}
      </header>
      )}
      <nav className="project-tabs" aria-label="Dashboard sections">
        {SIDEBAR_TABS.map(([key, label]) => (
          <button key={key} className={`project-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)} aria-selected={tab === key}>
            {label}{tabBadge(key) != null ? <span className="project-tab-badge">{tabBadge(key)}</span> : null}
          </button>
        ))}
      </nav>

      {error ? (
        <p className="project-empty">{error}</p>
      ) : (
        <>
          {tab === 'dashboard' && (
            <>
<section className="admin-card" aria-label="Stages">
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
                  {stageTotal > 0 ? (
                    <div className="premium-stage-mix" aria-label="Stage distribution">
                      <div className="premium-stage-mix-meta"><span>Stage mix</span><span>{stageTotal.toLocaleString('en-US')} trades</span></div>
                      <div className="premium-stage-mix-bar" role="img" aria-label={`Stage mix: ${STAGES.map((st) => `${stageCounts[st.key] ?? 0} ${st.label}`).join(', ')}`}>
                        {STAGES.map((st) => (
                          <span key={st.key} className={`premium-stage-seg premium-stage-seg--${st.key}`} style={{ width: stageShare(st.key) }} />
                        ))}
                      </div>
                      <div className="premium-stage-mix-labels">
                        {STAGES.map((st) => (
                          <span key={st.key}>{st.label} {stageCounts[st.key] ?? 0}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </section>
<section className="admin-card" aria-label="Latest trades">
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
                              <td key={h}>{field === 'stage' ? <StagePill stage={t.stage} /> : field === 'buyer' || field === 'seller' ? <PartyCell name={t[field]} /> : show(t[field])}</td>
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
                          <span className="project-card-stage"><StagePill stage={t.stage} /></span>
                        </div>
                        <p className="project-card-sub">{show(t.commodity)}{t.quantity != null ? ` · ${show(t.quantity)}` : ''}{t.disport ? ` · ${show(t.disport)}` : ''}</p>
                        <dl className="project-card-fields">
                          <div><dt>Buyer</dt><dd><PartyCell name={t.buyer} /></dd></div>
                          <div><dt>Seller</dt><dd><PartyCell name={t.seller} /></dd></div>
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
            </>
          )}

          {tab === 'queue' && (
            <section className="admin-card" aria-label="Queue">
              <h2>Queue</h2>
              {pageIsLoading ? (
                <p className="project-empty">Loading queue…</p>
              ) : pageErr ? (
                <PageErrorNote error={pageErr} onRetry={retryCurrentPage} />
              ) : pageRows.length === 0 ? (
                <p className="project-empty">No trades queued yet. The one-trader test will land here.</p>
              ) : (
                <>
                  <ul className="project-list premium-list">
                    {pageRows.map((q, i) => (
                      <li key={q.id}>
                        <div className="project-row">
                          <span className="project-row-name">
                            {i + 1}. {show(q.subject || q.message_id)}
                          </span>
                          <span className="muted">
                            {show(q.sender)} · {q.status} · {when(q.created_at)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <LoadMoreFooter loaded={pageRows.length} total={pageTotal} loading={pageLoadingMore} error={pageLoadMoreError} onRetry={retryCurrentPage} onLoadMore={() => setPageNums((prev) => ({ ...prev, queue: prev.queue + 1 }))} />
                </>
              )}
            </section>
          )}

          {tab === 'stages' && (
            <section className="admin-card" aria-label="Stages">
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
                  {stageTotal > 0 ? (
                    <div className="premium-stage-mix" aria-label="Stage distribution">
                      <div className="premium-stage-mix-meta"><span>Stage mix</span><span>{stageTotal.toLocaleString('en-US')} trades</span></div>
                      <div className="premium-stage-mix-bar" role="img" aria-label={`Stage mix: ${STAGES.map((st) => `${stageCounts[st.key] ?? 0} ${st.label}`).join(', ')}`}>
                        {STAGES.map((st) => (
                          <span key={st.key} className={`premium-stage-seg premium-stage-seg--${st.key}`} style={{ width: stageShare(st.key) }} />
                        ))}
                      </div>
                      <div className="premium-stage-mix-labels">
                        {STAGES.map((st) => (
                          <span key={st.key}>{st.label} {stageCounts[st.key] ?? 0}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          )}

          {tab === 'latest' && (
            <section className="admin-card" aria-label="Latest trades">
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
                              <td key={h}>{field === 'stage' ? <StagePill stage={t.stage} /> : field === 'buyer' || field === 'seller' ? <PartyCell name={t[field]} /> : show(t[field])}</td>
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
                          <span className="project-card-stage"><StagePill stage={t.stage} /></span>
                        </div>
                        <p className="project-card-sub">{show(t.commodity)}{t.quantity != null ? ` · ${show(t.quantity)}` : ''}{t.disport ? ` · ${show(t.disport)}` : ''}</p>
                        <dl className="project-card-fields">
                          <div><dt>Buyer</dt><dd><PartyCell name={t.buyer} /></dd></div>
                          <div><dt>Seller</dt><dd><PartyCell name={t.seller} /></dd></div>
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
                  <p className="muted">All trades, newest at the top (S/N 1 is the newest trade). Older trades load below as you scroll, one continuous list, not pages.</p>
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
                  ['extracted', 'Extracted', dbPageExtracted],
                  ['finished', 'Finished', dbPageFinished],
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
                  <div className="db-mix-meta"><span>Stage mix on loaded rows</span><span>{dbPageExtracted} extracted · {dbPageFinished} finished · {dbPageMatched} matched · {dbPageNew} new{dbPageOther > 0 ? ` · ${dbPageOther} other` : ''}</span></div>
                  <div className="db-mix-bar" role="img" aria-label={`${dbPageExtracted} extracted, ${dbPageFinished} finished, ${dbPageMatched} matched, ${dbPageNew} new on loaded rows`}>
                    <div className="db-mix-other" style={{ width: `${(dbPageExtracted / pageRows.length) * 100}%` }} />
                    <div className="db-mix-other" style={{ width: `${(dbPageFinished / pageRows.length) * 100}%` }} />
                    <div className="db-mix-matched" style={{ width: `${(dbPageMatched / pageRows.length) * 100}%` }} />
                    <div className="db-mix-new" style={{ width: `${(dbPageNew / pageRows.length) * 100}%` }} />
                  </div>
                </div>
              ) : null}
              {dbFilterActive ? <p className="muted db-filter-note">{dbFilteredRows.length} of {pageRows.length} loaded rows match this filter. Search and stage filter apply to the rows loaded so far only, not the whole collection.</p> : null}
              {pageIsLoading ? (
                <p className="project-empty">Loading trades…</p>
              ) : pageErr ? (
                <PageErrorNote error={pageErr} onRetry={retryCurrentPage} />
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
                        {dbFilteredRows.length === 0 ? (
                          <tr>
                            <td colSpan={SLIM_DB_COLUMNS.length + 3} className="project-empty">
                              {pageRows.length === 0 ? 'No trades saved yet.' : 'No trades on this page match these filters.'}
                            </td>
                          </tr>
                        ) : (
                          dbFilteredRows.map(({ t, idx: i }) => (
                            <tr key={t.id}>
                              <td className="sn-col">{i + 1}</td>
                              <td><span className="db-ref">{show(t.contract_ref)}</span></td>
                              <td><PartyCell name={t.buyer} /></td>
                              <td><PartyCell name={t.seller} /></td>
                              <td>{show(t.commodity)}</td>
                              <td className="db-num">{show(t.quantity)}</td>
                              <td>{show(t.disport)}</td>
                              <td><StagePill stage={t.stage} /></td>
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
                          <span className="project-card-sn">{i + 1}</span>
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
                          <button type="button" className="raw-message-btn project-card-primary" onClick={() => onOpenDetail(t)}>Details</button>
                          <button type="button" className="raw-message-btn project-card-primary" disabled={syncBusyId === t.id || pendingSyncIds.has(t.id) || syncedIds.has(t.id)} onClick={() => onRequestSync(t)}>{syncedIds.has(t.id) ? 'Synced' : pendingSyncIds.has(t.id) ? 'Sync requested' : syncBusyId === t.id ? 'Requesting…' : 'Sync'}</button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <LoadMoreFooter loaded={pageRows.length} total={pageTotal} loading={pageLoadingMore} error={pageLoadMoreError} onRetry={retryCurrentPage} onLoadMore={() => setPageNums((prev) => ({ ...prev, database: prev.database + 1 }))} />
                </>
              )}
            </section>
          )}

          {tab === 'references' && (
            <section className="admin-card" aria-label="References">
              <h2>References</h2>
              <p className="muted">Newest first, latest at the top (S/N 1 is the newest reference). Older references load below as you scroll, one continuous list, not pages.</p>
              {pageIsLoading ? (
                <p className="project-empty">Loading references…</p>
              ) : pageErr ? (
                <PageErrorNote error={pageErr} onRetry={retryCurrentPage} />
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
                  <div className="project-card-list" aria-label="Reference cards">
                    {pageRows.map((r, i) => (
                      <article key={r.id} className="project-card">
                        <div className="project-card-head">
                          <span className="project-card-sn">{i + 1}</span>
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
                  <LoadMoreFooter loaded={pageRows.length} total={pageTotal} loading={pageLoadingMore} error={pageLoadMoreError} onRetry={retryCurrentPage} onLoadMore={() => setPageNums((prev) => ({ ...prev, references: prev.references + 1 }))} />
                </>
              )}
            </section>
          )}

          {tab === 'notes' && (
            <section className="admin-card" aria-label="Notes">
              <h2>Notes</h2>
              <p className="muted">Newest first, latest at the top (S/N 1 is the newest note). Older notes load below as you scroll, one continuous list, not pages. Rows load in 50-row chunks behind the scenes; there is no page navigation.</p>
              {pageIsLoading ? (
                <p className="project-empty">Loading notes…</p>
              ) : pageErr ? (
                <PageErrorNote error={pageErr} onRetry={retryCurrentPage} />
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
                              <td className="sn-col">{i + 1}</td>
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
                          <span className="project-card-sn">{i + 1}</span>
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
                  <LoadMoreFooter loaded={pageRows.length} total={pageTotal} loading={pageLoadingMore} error={pageLoadMoreError} onRetry={retryCurrentPage} onLoadMore={() => setPageNums((prev) => ({ ...prev, notes: prev.notes + 1 }))} />
                </>
              )}
            </section>
          )}

          {tab === 'log' && (
            <section className="admin-card" aria-label="Sync log">
              <h2>Sync log</h2>
              <p className="muted">Queue items and their sync requests and results together, in order, in one list. Tap Details on any entry for its full fields. Nothing here creates a sync request and no sync data is changed; sync requests are made from Database and Latest.</p>
              {pageIsLoading && combinedLog.length === 0 ? (
                <p className="project-empty">Loading sync log…</p>
              ) : pageErr && combinedLog.length === 0 ? (
                <PageErrorNote error={pageErr} onRetry={retryCurrentPage} />
              ) : combinedLog.length === 0 ? (
                <p className="project-empty">No queue items or log entries yet.</p>
              ) : (
                <>
                  {pageErr ? (
                    <div className="project-loadmore-error-wrap" role="alert">
                      <p className="project-empty">Sync entries could not be loaded: {pageErr}. Queue items below are still shown.</p>
                      <button type="button" className="project-pager-btn" onClick={retryCurrentPage}>
                        Retry sync entries
                      </button>
                    </div>
                  ) : null}
                  {logQueueError ? (
                    <div className="project-loadmore-error-wrap" role="alert">
                      <p className="project-empty">Queue items could not be loaded: {logQueueError}. Sync entries below are still shown.</p>
                      <button type="button" className="project-pager-btn" onClick={retryLogQueue}>
                        Retry queue
                      </button>
                    </div>
                  ) : null}
                  {logQueueLoading ? <p className="muted">Loading queue items…</p> : null}
                  <ul className="project-list premium-list sync-log-list">
                    {combinedLog.map((entry, i) => {
                      const row = entry.row
                      const isSync = entry.kind === 'sync'
                      const pill = isSync
                        ? row.target === 'sync_request'
                          ? <span className="sync-pill sync-pill--request">Request</span>
                          : row.success
                            ? <span className="sync-pill sync-pill--success">Success</span>
                            : <span className="sync-pill sync-pill--failure">Failed</span>
                        : <span className="sync-pill sync-pill--queue">Queue</span>
                      return (
                        <li key={`${entry.kind}-${row.id}`}>
                          <div className="project-row sync-log-row">
                            <span className="project-row-name">
                              {i + 1}. {isSync ? `${show(row.target)} · trade ${show(row.trade_id)}` : `${show(row.subject || row.message_id)} · ${show(row.sender)}`}
                            </span>
                            <span className="sync-log-meta">
                              {pill}
                              <span className="muted">{isSync ? show(row.target) : show(row.status)} · {when(row.created_at)}</span>
                              <button type="button" className="raw-message-btn" onClick={() => setSyncDetail(entry)} aria-label={`View full details for ${isSync ? `sync entry ${row.id}` : `queue item ${row.id}`}`}>
                                Details
                              </button>
                            </span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="muted">Showing {combinedLog.length} combined entries: {pageRows.length} of {pageTotal} sync entries loaded{logQueueTotal != null ? `, ${logQueue.length} of ${logQueueTotal} queue items loaded` : ''}. Older sync entries load below as you scroll.</p>
                  <LoadMoreFooter loaded={pageRows.length} total={pageTotal} loading={pageLoadingMore} error={pageLoadMoreError} onRetry={retryCurrentPage} onLoadMore={() => setPageNums((prev) => ({ ...prev, log: prev.log + 1 }))} />
                </>
              )}
            </section>
          )}
        </>
      )}
      </div>
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
      {syncDetail && (
        <div className="raw-message-backdrop" onClick={() => setSyncDetail(null)} role="presentation">
          <div className="raw-message-dialog" role="dialog" aria-modal="true" aria-label={`Full details for ${syncDetail.kind === 'sync' ? `sync entry ${syncDetail.row.id}` : `queue item ${syncDetail.row.id}`}`} onClick={(e) => e.stopPropagation()}>
            <div className="raw-message-dialog-head">
              <strong>
                {syncDetail.kind === 'sync' ? `Sync entry ${syncDetail.row.id} · ${show(syncDetail.row.target)} · trade ${show(syncDetail.row.trade_id)}` : `Queue item ${syncDetail.row.id} · ${show(syncDetail.row.subject || syncDetail.row.message_id)}`}
              </strong>
              <button type="button" className="raw-message-close" onClick={() => setSyncDetail(null)} aria-label="Close">
                Close
              </button>
            </div>
            <div className="raw-message-dialog-body">
              <dl className="project-detail-list">
                {syncDetailFields(syncDetail).map(([k, v]) => (
                  <div key={k} className="project-detail-row">
                    <dt>{k}</dt>
                    <dd>{k.endsWith('_at') ? when(v) : show(v)}</dd>
                  </div>
                ))}
              </dl>
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
                  {detailLongVisible.length > 0 ? (
                    <>
                      <h3 className="admin-detail-heading">Long text</h3>
                      <dl className="project-detail-list">
                        {detailLongVisible.map((f) => (
                          <div key={f.col} className="project-detail-row">
                            <dt>{f.col}</dt>
                            <dd>{show(f.value)}</dd>
                          </div>
                        ))}
                      </dl>
                    </>
                  ) : null}
                  <h3 className="admin-detail-heading">All fields</h3>
                  <dl className="project-detail-list">
                    {detailOtherVisible.map((f) => (
                      <div key={f.col} className="project-detail-row">
                        <dt>{f.col}</dt>
                        <dd>{show(f.value)}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <>
                  {detailLongVisible.length > 0 ? (
                  <>
                    <h3 className="admin-detail-heading">Long text</h3>
                    <dl className="project-detail-list">
                      {detailLongVisible.map((f) => (
                        <div key={f.col} className="project-detail-row">
                          <dt>{f.col}</dt>
                          <dd>{show(f.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                ) : null}
                <h3 className="admin-detail-heading">All fields</h3>
                <dl className="project-detail-list">
                  {detailOtherVisible.map((f) => (
                    <div key={f.col} className="project-detail-row">
                      <dt>{f.col}</dt>
                      <dd>{show(f.value)}</dd>
                    </div>
                  ))}
                </dl>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
