import { useEffect, useState } from 'react'

// Server-backed Project pages for the Mercancia trade upgrade.
// Projects now live in the server tables from migration 0019
// (projects, trade_queue, trades, trade_references, trade_notes,
// trade_sync_log), read and written through /api/projects, never in
// browser localStorage. Every request runs as the signed-in caller under
// the normal row-level security rules: a project is visible only to its
// owner, the group owner (username 'mubarak'), or an AI member ('adam'
// or 'ali'); other members get no rows. There is still no Sheets sync,
// no Drive folder, and no Apps Script link here: the Sync log tab is
// the in-app sync log, not Google Sheets, and it is not the Notes log.
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
      <p className="muted">Done opens a new dashboard for this project. Nothing is synced to Google Sheets, Drive, or Apps Script in this build.</p>
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
    if (tab !== 'database' || dbTrades !== null) return undefined
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

  const queue = data?.queue ?? []
  const trades = data?.trades ?? []
  const syncLog = data?.sync_log ?? []
  const linkedQueueIds = new Set(trades.map((t) => t.queue_id).filter((id) => id != null))
  const stageCount = (key) =>
    trades.filter((t) => t.stage === key).length +
    queue.filter((q) => q.status === key && !linkedQueueIds.has(q.id)).length

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
    ? [...Object.keys(firstFull.full_data), 'Stage']
    : SIMPLE_COLUMNS.map(([h]) => h)
  const dbCell = (t, col) => {
    if (col === 'Stage') return show(t.stage)
    if (firstFull) return t.full_data && typeof t.full_data === 'object' ? show(t.full_data[col]) : '—'
    const field = SIMPLE_COLUMNS.find(([h]) => h === col)?.[1]
    return show(field ? t[field] : undefined)
  }
  const dbFullCount = dbRows.filter((t) => t.full_data && typeof t.full_data === 'object').length

  // Database, References, Notes, and Sync log tabs are the sheet-like
  // views: they use the wide page variant (no 900px cap), while Queue,
  // Stages, the project list and the create form keep the centered
  // page. The per-tab class on main is only for the per-page header
  // colour in styles.css; it changes no layout on its own.
  const wide = tab === 'database' || tab === 'references' || tab === 'notes' || tab === 'log'
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
              {queue.length === 0 ? (
                <p className="project-empty">No trades queued yet. The one-trader test will land here.</p>
              ) : (
                <ul className="project-list">
                  {queue.map((q) => (
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
              <p className="muted">
                Own database view inside the app, full width like the TradesDB sheet. Scroll sideways for more columns.
                {dbRows.length > 0 && firstFull
                  ? ` ${dbFullCount} of ${dbRows.length} trades have full trade data; the rest show — until the backfill runs.`
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
                        {dbColumns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dbRows.length === 0 ? (
                        <tr>
                          <td colSpan={Math.max(dbColumns.length, 1)} className="project-empty">
                            No trades saved yet.
                          </td>
                        </tr>
                      ) : (
                        dbRows.map((t) => (
                          <tr key={t.id}>
                            {dbColumns.map((col) => (
                              <td key={col}>{dbCell(t, col)}</td>
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
                        {REFERENCE_COLUMNS.map(([h]) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(refRows ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={REFERENCE_COLUMNS.length} className="project-empty">
                            No references saved yet.
                          </td>
                        </tr>
                      ) : (
                        (refRows ?? []).map((r) => (
                          <tr key={r.id}>
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
                        {NOTE_COLUMNS.map(([h]) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(noteRows ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={NOTE_COLUMNS.length} className="project-empty">
                            No notes saved yet.
                          </td>
                        </tr>
                      ) : (
                        (noteRows ?? []).map((n) => (
                          <tr key={n.id}>
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
              <p className="muted">In-app Sheets sync attempts, not the Notes log. Sheets sync is not in this build.</p>
              {syncLog.length === 0 ? (
                <p className="project-empty">No log entries yet.</p>
              ) : (
                <ul className="project-list">
                  {syncLog.map((s) => (
                    <li key={s.id}>
                      <div className="project-row">
                        <span className="project-row-name">
                          {show(s.target)} · {s.success ? 'ok' : 'failed'}
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
    </main>
  )
}
