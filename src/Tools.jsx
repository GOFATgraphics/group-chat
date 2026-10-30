import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase.js'

// Team tools (the AI members' wishlist): pinned messages, polls, shared
// notes / tasks / decisions, scheduled messages and reminders, and search.
// The database rules (migration 0015) decide who may see or change what.

// ---- conversation helpers ------------------------------------------------

// Where a shared note lives for a view: main group (all null), named group,
// or a private chat stored as a sorted pair.
export function itemScope(view, myId) {
  if (view.type === 'group') return { group_id: view.groupId ?? null, dm_a: null, dm_b: null }
  const [a, b] = view.type === 'owner' ? [view.aId, view.bId].sort() : [myId, view.peerId].sort()
  return { group_id: null, dm_a: a, dm_b: b }
}
export function scopeQuery(query, scope) {
  query = scope.group_id ? query.eq('group_id', scope.group_id) : query.is('group_id', null)
  return scope.dm_a ? query.eq('dm_a', scope.dm_a).eq('dm_b', scope.dm_b) : query.is('dm_a', null)
}

// ---- pinned messages ---------------------------------------------------

export function PinStrip({ pins, profiles, onJump, preview }) {
  const [index, setIndex] = useState(0)
  if (!pins.length) return null
  const i = index % pins.length
  const m = pins[i]
  return (
    <button
      className="pin-strip"
      onClick={() => {
        onJump(m.id)
        setIndex(i + 1)
      }}
      aria-label={`Pinned message ${i + 1} of ${pins.length}. Tap to go to it.`}
    >
      <span className="pin-icon" aria-hidden="true">📌</span>
      <span className="pin-text">
        <b>{pins.length > 1 ? `Pinned ${i + 1} of ${pins.length}` : 'Pinned'}</b>
        <span>
          {profiles[m.user_id] ?? '…'}: {preview(m)}
        </span>
      </span>
    </button>
  )
}

// ---- polls -------------------------------------------------------------

// iMessage-style poll: each choice is its own pill on the sender's side.
// Choices with votes are filled and show who voted; empty ones are pale with
// an empty circle; a pill grows with its share of the votes. Tap to vote
// (tap again to take it back), "Add Choice" adds an option for everyone.
export function PollCard({ poll, myId, profiles, avatars = {}, Avatar, readOnly, mine, onChange, onError, footer }) {
  const votes = poll.poll_votes ?? []
  const myVotes = new Set(votes.filter((v) => v.user_id === myId).map((v) => v.option))
  const counts = poll.options.map((_, i) => votes.filter((v) => v.option === i).length)
  const top = Math.max(1, ...counts)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [choice, setChoice] = useState('')

  async function vote(i) {
    if (readOnly || busy) return
    setBusy(true)
    const next = poll.multiple ? new Set(myVotes) : new Set()
    if (myVotes.has(i)) next.delete(i)
    else next.add(i)
    await supabase.from('poll_votes').delete().eq('poll_id', poll.id).eq('user_id', myId)
    if (next.size) await supabase.from('poll_votes').insert([...next].map((option) => ({ poll_id: poll.id, option })))
    setBusy(false)
    onChange?.()
  }

  async function addChoice(e) {
    e.preventDefault()
    const t = choice.trim()
    if (!t) return setAdding(false)
    const { error } = await supabase.rpc('add_poll_option', { p_poll: poll.id, p_text: t })
    if (error) return onError?.(error.message)
    setChoice('')
    setAdding(false)
    onChange?.()
  }

  return (
    <div className={`ipoll ${mine ? 'mine' : ''}`} role="group" aria-label={`Poll: ${poll.question}`}>
      <div className="ipoll-question">{poll.question}</div>
      {poll.options.map((text, i) => {
        const who = votes.filter((v) => v.option === i).map((v) => v.user_id)
        const voted = who.length > 0
        const width = 58 + 42 * (counts[i] / top)
        return (
          <button
            key={i}
            className={`ipoll-option ${voted ? 'voted' : ''} ${myVotes.has(i) ? 'mine-vote' : ''}`}
            style={{ width: `${width}%` }}
            onClick={() => vote(i)}
            disabled={readOnly}
            aria-pressed={myVotes.has(i)}
            title={who.map((id) => profiles[id] ?? '…').join(', ')}
          >
            <span className="ipoll-text">{text}</span>
            {voted ? (
              <span className="ipoll-faces">
                {who.slice(0, 3).map((id) => (Avatar ? <Avatar key={id} name={profiles[id] ?? '?'} src={avatars[id]} /> : null))}
                {who.length > 3 && <span className="ipoll-more">+{who.length - 3}</span>}
              </span>
            ) : (
              <span className="ipoll-circle" aria-hidden="true" />
            )}
          </button>
        )
      })}
      {adding && (
        <form className="ipoll-add" onSubmit={addChoice}>
          <input autoFocus value={choice} maxLength={120} placeholder="New choice" onChange={(e) => setChoice(e.target.value)} onBlur={addChoice} />
        </form>
      )}
      <div className="ipoll-foot">
        {!readOnly && poll.options.length < 10 && !adding && (
          <button className="ipoll-addbtn" onClick={() => setAdding(true)}>
            Add Choice
          </button>
        )}
        {footer && (
          <>
            {!readOnly && poll.options.length < 10 && !adding && <span aria-hidden="true"> · </span>}
            <span>{footer}</span>
          </>
        )}
      </div>
    </div>
  )
}

export function PollSheet({ onCreate, onCancel }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multiple, setMultiple] = useState(false)
  const [busy, setBusy] = useState(false)
  const filled = options.map((o) => o.trim()).filter(Boolean)
  const ready = question.trim() && filled.length >= 2 && !busy
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <form
        className="sheet tool-sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ready) return
          setBusy(true)
          await onCreate({ question: question.trim(), options: filled, multiple })
          setBusy(false)
        }}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <button type="button" className="sheet-cancel" onClick={onCancel}>Cancel</button>
          <span>New Poll</span>
          <button type="submit" className="sheet-done" disabled={!ready}>{busy ? '…' : 'Send'}</button>
        </div>
        <input className="group-name-input" placeholder="Ask a question" value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} autoFocus />
        <div className="sheet-section">Options</div>
        <div className="tool-list">
          {options.map((o, i) => (
            <div key={i} className="tool-row">
              <input
                placeholder={`Option ${i + 1}`}
                value={o}
                maxLength={120}
                onChange={(e) => setOptions((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 && (
                <button type="button" className="member-remove" onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove option">
                  −
                </button>
              )}
            </div>
          ))}
          {options.length < 10 && (
            <button type="button" className="tool-add" onClick={() => setOptions((prev) => [...prev, ''])}>
              ＋ Add option
            </button>
          )}
        </div>
        <label className="setting-row">
          <span>Allow more than one answer</span>
          <input type="checkbox" className="switch" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
        </label>
      </form>
    </div>
  )
}

// ---- notes, tasks and decisions ---------------------------------------

const TABS = [
  { kind: 'note', label: 'Notes', empty: 'Shared notes for this chat. Anyone here (including the AIs) can add or edit them.' },
  { kind: 'task', label: 'Tasks', empty: 'A shared to-do list. Tick things off when they are done.' },
  { kind: 'decision', label: 'Decisions', empty: 'What the team agreed, with the date, so it never gets lost in the scroll.' },
]

export function NotesSheet({ scope, title, readOnly, profiles, onClose, onError }) {
  const [tab, setTab] = useState('task')
  const [items, setItems] = useState(null)
  const [text, setText] = useState('')

  async function load() {
    const { data, error } = await scopeQuery(supabase.from('chat_items').select('*').order('created_at'), scope)
    if (error) onError?.(error.message)
    setItems(data ?? [])
  }
  useEffect(() => {
    load()
    const ch = supabase
      .channel(`items-${scope.group_id ?? scope.dm_a ?? 'main'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_items' }, () => load())
      .subscribe()
    return () => supabase.removeChannel(ch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.group_id, scope.dm_a, scope.dm_b])

  async function add(e) {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    setText('')
    const { error } = await supabase.from('chat_items').insert({ kind: tab, text: t, ...scope })
    if (error) onError?.(error.message)
    load()
  }
  async function toggle(item) {
    await supabase.from('chat_items').update({ done: !item.done, updated_at: new Date().toISOString() }).eq('id', item.id)
    load()
  }
  async function remove(item) {
    await supabase.from('chat_items').delete().eq('id', item.id)
    load()
  }

  const shown = (items ?? []).filter((i) => i.kind === tab)
  const current = TABS.find((t) => t.kind === tab)
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tool-sheet" role="dialog" aria-label="Notes, tasks and decisions" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <span>{title}</span>
          <button className="sheet-done" onClick={onClose}>Done</button>
        </div>
        <div className="segmented" role="tablist">
          {TABS.map((t) => (
            <button key={t.kind} role="tab" aria-selected={tab === t.kind} className={tab === t.kind ? 'on' : ''} onClick={() => setTab(t.kind)}>
              {t.label}
              {(items ?? []).filter((i) => i.kind === t.kind && !(t.kind === 'task' && i.done)).length > 0 && (
                <span className="seg-count">{(items ?? []).filter((i) => i.kind === t.kind && !(t.kind === 'task' && i.done)).length}</span>
              )}
            </button>
          ))}
        </div>
        {items == null ? (
          <p className="setting-note muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="setting-note muted">{current.empty}</p>
        ) : (
          <ul className="member-list item-list">
            {shown.map((item) => (
              <li key={item.id} className={item.done ? 'done' : ''}>
                {tab === 'task' ? (
                  <input type="checkbox" className="pick-check" checked={item.done} disabled={readOnly} onChange={() => toggle(item)} aria-label="Done" />
                ) : (
                  <span className="item-icon" aria-hidden="true">{tab === 'decision' ? '✅' : '📝'}</span>
                )}
                <span className="item-body">
                  <span className="item-text">{item.text}</span>
                  <span className="item-meta">
                    {profiles[item.updated_by ?? item.created_by] ?? '…'} ·{' '}
                    {new Date(item.updated_at ?? item.created_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                </span>
                {!readOnly && (
                  <button className="item-delete" onClick={() => remove(item)} aria-label="Delete">
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <form className="tool-add-row" onSubmit={add}>
            <input
              placeholder={tab === 'task' ? 'Add a task' : tab === 'decision' ? 'What did you decide?' : 'Write a note'}
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" disabled={!text.trim()}>Add</button>
          </form>
        )}
      </div>
    </div>
  )
}

// ---- scheduled messages and reminders ---------------------------------

const pad = (n) => String(n).padStart(2, '0')
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

export function ScheduleSheet({ target, onClose, onError }) {
  const [kind, setKind] = useState('message')
  const [text, setText] = useState('')
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 60 * 60 * 1000)))
  const [repeat, setRepeat] = useState('')
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(false)

  async function load() {
    let q = supabase.from('scheduled_messages').select('*').eq('done', false).neq('kind', 'task').order('send_at')
    q = target.group_id ? q.eq('group_id', target.group_id) : q.is('group_id', null)
    q = target.recipient_id ? q.eq('recipient_id', target.recipient_id) : q.is('recipient_id', null)
    const { data } = await q
    setList(data ?? [])
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(e) {
    e.preventDefault()
    const when = new Date(at)
    if (!text.trim() || Number.isNaN(when.getTime())) return
    if (when.getTime() < Date.now()) return onError?.('Pick a time in the future.')
    setBusy(true)
    const { error } = await supabase
      .from('scheduled_messages')
      .insert({ kind, content: text.trim(), send_at: when.toISOString(), repeat: repeat || null, ...target })
    setBusy(false)
    if (error) return onError?.(error.message)
    setText('')
    load()
  }
  async function cancel(id) {
    await supabase.from('scheduled_messages').delete().eq('id', id)
    load()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet tool-sheet" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <button type="button" className="sheet-cancel" onClick={onClose}>Close</button>
          <span>Schedule</span>
          <button type="submit" className="sheet-done" disabled={!text.trim() || busy}>{busy ? '…' : 'Save'}</button>
        </div>
        <div className="segmented">
          <button type="button" className={kind === 'message' ? 'on' : ''} onClick={() => setKind('message')}>Message</button>
          <button type="button" className={kind === 'reminder' ? 'on' : ''} onClick={() => setKind('reminder')}>⏰ Reminder</button>
        </div>
        <textarea
          className="group-name-input tool-text"
          placeholder={kind === 'reminder' ? 'Remind everyone to…' : 'Message to send later'}
          value={text}
          rows={3}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <div className="tool-list">
          <label className="tool-row">
            <span>When</span>
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
          <label className="tool-row">
            <span>Repeat</span>
            <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
              <option value="">Never</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
          </label>
        </div>
        {list.length > 0 && (
          <>
            <div className="sheet-section">Coming up</div>
            <ul className="member-list item-list">
              {list.map((s) => (
                <li key={s.id}>
                  <span className="item-icon" aria-hidden="true">{s.kind === 'reminder' ? '⏰' : '🕒'}</span>
                  <span className="item-body">
                    <span className="item-text">{s.content}</span>
                    <span className="item-meta">
                      {new Date(s.send_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}
                      {s.repeat ? ` · ${s.repeat}` : ''}
                    </span>
                  </span>
                  <button type="button" className="item-delete" onClick={() => cancel(s.id)} aria-label="Cancel">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </form>
    </div>
  )
}

// ---- search ------------------------------------------------------------

// Searches the whole history (or one chat) as you type.
export function useMessageSearch(query, filters = {}) {
  const [state, setState] = useState({ query: '', results: [], loading: false })
  const q = query.trim()
  const key = JSON.stringify(filters)
  useEffect(() => {
    if (q.length < 2) return setState({ query: q, results: [], loading: false })
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc('search_messages', { p_query: q, p_limit: 40, ...filters })
      if (!cancelled) setState({ query: q, results: data ?? [], loading: false })
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, key])
  return state
}

// The matching words in a result, highlighted, with a little context.
export function Highlighted({ text, query }) {
  const parts = useMemo(() => {
    const words = query.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (!words.length || !text) return [text]
    const first = text.toLowerCase().indexOf(query.trim().split(/\s+/)[0].toLowerCase())
    const start = first > 40 ? first - 30 : 0
    const snippet = (start ? '…' : '') + text.slice(start, start + 160)
    return snippet.split(new RegExp(`(${words.join('|')})`, 'gi'))
  }, [text, query])
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  )
}
