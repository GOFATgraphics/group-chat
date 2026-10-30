import { useState } from 'react'
import { useMessageSearch, Highlighted } from './Tools.jsx'
import { AIBadge, KIND_ICON, XIcon, SearchIcon as SearchGlyph } from './icons.jsx'

// The home screen: every conversation (the group chat, a private chat with
// each member, and for the owner the read-only view of other members' private
// chats), newest first, with the last message, its time, unread count, who's
// online and who's typing. On wide screens it stays beside the open chat.

export default function ChatList({ items, me, myAvatar, activeKey, onOpen, onSettings, onNewGroup, Avatar, profiles = {}, avatars = {}, chatNameOf, onOpenMessage }) {
  const [query, setQuery] = useState('')
  // Typing two or more letters also searches every message you can read.
  const found = useMessageSearch(onOpenMessage ? query : '')
  const q = query.trim().toLowerCase()
  const shown = q ? items.filter((c) => c.title.toLowerCase().includes(q) || (c.preview ?? '').toLowerCase().includes(q)) : items
  const chats = shown.filter((c) => !c.owner)
  const owner = shown.filter((c) => c.owner)

  return (
    <aside className="pane-list" aria-label="Chats">
      <div className="list-top">
        <button className="list-me" onClick={onSettings} aria-label="Your profile and settings">
          <Avatar name={me} src={myAvatar} />
        </button>
        <h1 className="list-title">Chats</h1>
        {onNewGroup && (
          <button className="list-new" onClick={onNewGroup} aria-label="New group">
            <NewGroupIcon />
          </button>
        )}
      </div>
      <label className="list-search">
        <SearchIcon />
        <input
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
        {query && (
          <button className="list-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <XIcon size={11} />
          </button>
        )}
      </label>
      <div className="list-scroll">
        <ul className="convo-list">
          {chats.map((c) => (
            <Row key={c.key} c={c} active={c.key === activeKey} onOpen={onOpen} Avatar={Avatar} />
          ))}
        </ul>
        {owner.length > 0 && (
          <>
            <div className="list-section">Owner view · read only</div>
            <ul className="convo-list">
              {owner.map((c) => (
                <Row key={c.key} c={c} active={c.key === activeKey} onOpen={onOpen} Avatar={Avatar} />
              ))}
            </ul>
          </>
        )}
        {query.trim().length >= 2 && onOpenMessage && (
          <>
            <div className="list-section">Messages{found.loading ? ' · searching…' : ''}</div>
            {!found.loading && found.results.length === 0 && <div className="list-empty">No messages match “{query.trim()}”.</div>}
            <ul className="convo-list">
              {found.results.map((m) => (
                <li key={m.id}>
                  <button className="convo search-result" onClick={() => onOpenMessage(m)}>
                    <span className="convo-avatar small">
                      <Avatar name={profiles[m.user_id] ?? '?'} src={avatars[m.user_id]} />
                    </span>
                    <span className="convo-body">
                      <span className="convo-line">
                        <span className="convo-title">{chatNameOf?.(m) ?? ''}</span>
                        <span className="convo-time">{listTime(m.created_at)}</span>
                      </span>
                      <span className="convo-preview">
                        <b>{profiles[m.user_id] ?? '…'}:</b> <Highlighted text={m.content} query={found.query} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {!shown.length && query.trim().length < 2 && <div className="list-empty">No chats match “{query}”.</div>}
      </div>
    </aside>
  )
}

function Row({ c, active, onOpen, Avatar }) {
  const unread = c.unread > 0
  return (
    <li>
      <button
        className={`convo ${active ? 'active' : ''} ${unread ? 'unread' : ''}`}
        onClick={() => onOpen(c.view)}
        aria-label={`${c.title}${c.online ? ', online' : ''}${unread ? `, ${c.unread} unread` : ''}`}
        aria-current={active ? 'true' : undefined}
      >
        <span className="convo-dot" aria-hidden="true" />
        <span className="convo-avatar">
          {c.faces ? (
            <span className={`convo-faces n${c.faces.length}`}>
              {c.faces.map((f) => (
                <Avatar key={f.id} name={f.name} src={f.src} />
              ))}
            </span>
          ) : (
            <Avatar name={c.title} src={c.avatar} />
          )}
          {c.online && <span className="convo-online" />}
        </span>
        <span className="convo-body">
          <span className="convo-line">
            <span className="convo-title">
              {c.title}
              {c.ai && <AIBadge />}
            </span>
            <span className="convo-time">{c.time}</span>
            <ChevronRight />
          </span>
          <span className={`convo-preview ${c.typing ? 'typing' : ''}`}>
            {c.typing ? (
              'typing…'
            ) : c.preview ? (
              <>
                {c.kind && KIND_ICON[c.kind] && (() => {
                  const K = KIND_ICON[c.kind]
                  return <K size={15} className="preview-icon" />
                })()}
                {c.preview}
              </>
            ) : (
              <span className="muted">{c.emptyText}</span>
            )}
          </span>
        </span>
        {unread && <span className="convo-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
      </button>
    </li>
  )
}

const NewGroupIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path d="M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const SearchIcon = () => (
  <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
    <circle cx="8.5" cy="8.5" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="M13 13l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
const ChevronRight = () => (
  <svg className="convo-chevron" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
    <path d="M1.5 1.5L6.5 7l-5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// "4:19 PM" today, "Yesterday", a weekday within the week, else a short date.
export function listTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'numeric', year: '2-digit' })
}

// One line describing a message in the list: text, or what was sent.
export function listPreview(m) {
  if (!m) return ''
  if (m.call_duration != null) return 'Voice call'
  let text = m.content?.trim() ?? ''
  if (text.startsWith('📊 ')) {
    text = text.slice(2).trim()
    return text.startsWith('Poll:') ? text : `Poll: ${text}`
  }
  if (text.startsWith('⏰ ')) return text.slice(2).trim()
  if (text.startsWith('🗂 ')) return text.slice(2).trim()
  if (m.attachment_path) {
    const type = m.attachment_type ?? ''
    const what = type.startsWith('image/')
      ? 'Photo'
      : type.startsWith('video/')
        ? 'Video'
        : type.startsWith('audio/')
          ? 'Voice note'
          : m.attachment_name ?? 'File'
    return text ? `${what} · ${text}` : what
  }
  return text
}
