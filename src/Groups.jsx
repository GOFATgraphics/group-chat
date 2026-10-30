import { useState } from 'react'

// Sheet for making a named group (name + people) or adding people to one.
// mode "create" asks for a name; mode "add" only picks people.
export default function GroupSheet({ mode = 'create', people, Avatar, onDone, onCancel }) {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const ready = picked.size > 0 && (mode === 'add' || name.trim().length > 0) && !busy

  async function submit(e) {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    await onDone({ name: name.trim(), ids: [...picked] })
    setBusy(false)
  }

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <form
        className="sheet group-sheet"
        role="dialog"
        aria-label={mode === 'create' ? 'New group' : 'Add people'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <button type="button" className="sheet-cancel" onClick={onCancel}>
            Cancel
          </button>
          <span>{mode === 'create' ? 'New Group' : 'Add People'}</span>
          <button type="submit" className="sheet-done" disabled={!ready}>
            {busy ? '…' : mode === 'create' ? 'Create' : 'Add'}
          </button>
        </div>
        {mode === 'create' && (
          <input
            className="group-name-input"
            placeholder="Group name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            enterKeyHint="done"
          />
        )}
        <div className="sheet-section">{picked.size ? `${picked.size} selected` : 'Choose people'}</div>
        {people.length === 0 ? (
          <p className="setting-note muted">Everyone is already in this group.</p>
        ) : (
          <ul className="member-list pick-list">
            {people.map((p) => (
              <li key={p.id}>
                <label>
                  <Avatar name={p.name} src={p.avatar} />
                  <span className="member-name">
                    {p.name}
                    {p.ai && <span className="ai-badge">AI</span>}
                  </span>
                  <input type="checkbox" className="pick-check" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </form>
    </div>
  )
}
