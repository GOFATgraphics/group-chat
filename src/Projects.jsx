import { useState } from 'react'

// Local-only Project pages for the Mercancia trade upgrade, phase 1.
// Projects live in browser localStorage only in this build. There is no
// server table, no Sheets sync, no Drive folder, and no Apps Script link
// here. A future migration (0019_projects.sql, draft only, not applied)
// defines the server tables this UI will eventually read from.

const STORAGE_KEY = 'gc-projects-v1'

export function loadProjects() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((p) => p && p.id && p.name) : []
  } catch {
    return []
  }
}

export function saveProjects(projects) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
  } catch {
    // Storage full or unavailable: the list just does not persist.
  }
}

export function createProjectRecord(name) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, createdAt: new Date().toISOString() }
}

// Whole-page projects list. Back goes to chats.
export function ProjectsList({ projects, onCreate, onOpen, onBack }) {
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
      {projects.length === 0 ? (
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
export function CreateProject({ onDone, onBack }) {
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

// Whole-page dashboard for one project. Tabs, not a chat pane.
export function ProjectDashboard({ project, onBack }) {
  const [tab, setTab] = useState('queue')
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

      {tab === 'queue' && (
        <section aria-label="Queue">
          <h2>Queue</h2>
          <p className="project-empty">No trades queued yet. The one-trader test will land here.</p>
        </section>
      )}

      {tab === 'stages' && (
        <section aria-label="Stages">
          <h2>Stages</h2>
          <div className="project-stage-grid">
            {STAGES.map((s) => (
              <article key={s.key} className="project-stage-card">
                <div className="project-stage-count">0</div>
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
          <p className="muted">Own database view inside the app. No data yet in this local build.</p>
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
                <tr>
                  <td colSpan="7" className="project-empty">
                    No trades saved yet.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'log' && (
        <section aria-label="Trade log view">
          <h2>Trade log view</h2>
          <p className="muted">In-app log, not Google Sheets. Sheets sync is not in this build.</p>
          <p className="project-empty">No log entries yet.</p>
        </section>
      )}
    </main>
  )
}
