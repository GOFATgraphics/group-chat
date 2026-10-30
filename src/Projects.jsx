import { useEffect, useState } from 'react'

// Server-backed Project pages for the Mercancia trade upgrade.
// Projects now live in the server tables from migration 0019
// (projects, trade_queue, trades, trade_references, trade_notes,
// trade_sync_log), read and written through /api/projects, never in
// browser localStorage. Every request runs as the signed-in caller under
// the normal row-level security rules: a project is visible only to its
// owner, the group owner (username 'mubarak'), or an AI member ('adam'
// or 'ali'); other members get no rows. There is still no Sheets sync,
// no Drive folder, and no Apps Script link here: the trade log view is
// the in-app sync log, not Google Sheets.

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
      <p className="muted">Projects are containers for trade work. Each project gets its own queue, stages, database view, and trade log view.</p>
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
export function ProjectDashboard({ project, token, onBack }) {
  const [tab, setTab] = useState('queue')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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

  const queue = data?.queue ?? []
  const trades = data?.trades ?? []
  const syncLog = data?.sync_log ?? []
  const linkedQueueIds = new Set(trades.map((t) => t.queue_id).filter((id) => id != null))
  const stageCount = (key) =>
    trades.filter((t) => t.stage === key).length +
    queue.filter((q) => q.status === key && !linkedQueueIds.has(q.id)).length

  return (
    <main className="project-page" aria-label={`Dashboard for ${project.name}`}>
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
          ['log', 'Trade log view'],
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
              <p className="muted">Own database view inside the app.</p>
              <div className="project-table-wrap">
                <table className="project-table">
                  <thead>
                    <tr>
                      <th>Contract ref</th>
                      <th>Buyer</th>
                      <th>Seller</th>
                      <th>Commodity</th>
                      <th>Quantity</th>
                      <th>Disport</th>
                      <th>Stage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="project-empty">
                          No trades saved yet.
                        </td>
                      </tr>
                    ) : (
                      trades.map((t) => (
                        <tr key={t.id}>
                          <td>{show(t.contract_ref)}</td>
                          <td>{show(t.buyer)}</td>
                          <td>{show(t.seller)}</td>
                          <td>{show(t.commodity)}</td>
                          <td>{show(t.quantity)}</td>
                          <td>{show(t.disport)}</td>
                          <td>{show(t.stage)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'log' && (
            <section aria-label="Trade log view">
              <h2>Trade log view</h2>
              <p className="muted">In-app log, not Google Sheets. Sheets sync is not in this build.</p>
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
