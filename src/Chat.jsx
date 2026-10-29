import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { supabase, BUCKET } from './supabase.js'

const PAGE_SIZE = 100
const MAX_FILE_BYTES = 25 * 1024 * 1024
const URL_TTL_SECONDS = 60 * 60 * 12
const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓', '🔥']
const GROUP_WINDOW_MS = 5 * 60 * 1000
const STAMP_GAP_MS = 15 * 60 * 1000
const LONG_PRESS_MS = 450

export default function Chat({ session }) {
  const myId = session.user.id
  const [me, setMe] = useState(undefined)
  const [profiles, setProfiles] = useState({})
  const [messages, setMessages] = useState([])
  const [reactions, setReactions] = useState({})
  const [urls, setUrls] = useState({})
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState([])
  const [error, setError] = useState('')
  const [pickerFor, setPickerFor] = useState(null)
  const [showMembers, setShowMembers] = useState(false)
  const [lightbox, setLightbox] = useState(null)

  const listRef = useRef(null)
  const stickToBottom = useRef(true)
  const preserveScroll = useRef(null)

  // ---- data helpers --------------------------------------------------------

  const signUrls = useCallback(async (paths) => {
    const todo = paths.filter(Boolean)
    if (!todo.length) return
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(todo, URL_TTL_SECONDS)
    if (!data) return
    setUrls((prev) => {
      const next = { ...prev }
      for (const item of data) if (item.signedUrl) next[item.path] = item.signedUrl
      return next
    })
  }, [])

  const loadReactions = useCallback(async (ids) => {
    if (!ids.length) return
    const { data } = await supabase.from('reactions').select('message_id, user_id, emoji').in('message_id', ids)
    setReactions((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = []
      for (const r of data ?? []) next[r.message_id].push({ user_id: r.user_id, emoji: r.emoji })
      return next
    })
  }, [])

  const profilesRef = useRef(profiles)
  profilesRef.current = profiles

  const ensureProfile = useCallback(async (userId) => {
    if (profilesRef.current[userId]) return
    const { data } = await supabase.from('profiles').select('id, username').eq('id', userId).single()
    if (data) setProfiles((p) => ({ ...p, [data.id]: data.username }))
  }, [])

  const addMessage = useCallback(
    (msg) => {
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
      setReactions((prev) => (prev[msg.id] ? prev : { ...prev, [msg.id]: [] }))
      ensureProfile(msg.user_id)
      if (msg.attachment_path) signUrls([msg.attachment_path])
    },
    [ensureProfile, signUrls],
  )

  const applyReaction = useCallback((messageId, userId, emoji, present) => {
    setReactions((prev) => {
      const list = prev[messageId] ?? []
      const exists = list.some((r) => r.user_id === userId && r.emoji === emoji)
      if (present === exists) return prev
      return {
        ...prev,
        [messageId]: present
          ? [...list, { user_id: userId, emoji }]
          : list.filter((r) => !(r.user_id === userId && r.emoji === emoji)),
      }
    })
  }, [])

  // ---- initial load + realtime ---------------------------------------------

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [{ data: meRow }, { data: profileRows }, { data: msgRows, error: msgErr }] = await Promise.all([
        supabase.from('profiles').select('id, username').eq('id', myId).maybeSingle(),
        supabase.from('profiles').select('id, username'),
        supabase.from('messages').select('*').order('id', { ascending: false }).limit(PAGE_SIZE),
      ])
      if (cancelled) return
      setMe(meRow ?? null)
      if (!meRow) return setLoading(false)
      if (msgErr) setError(msgErr.message)

      const rows = (msgRows ?? []).reverse()
      setProfiles(Object.fromEntries((profileRows ?? []).map((p) => [p.id, p.username])))
      setMessages(rows)
      setHasMore((msgRows ?? []).length === PAGE_SIZE)
      setLoading(false)
      loadReactions(rows.map((m) => m.id))
      signUrls(rows.map((m) => m.attachment_path))
    }
    load()

    const channel = supabase
      .channel('group-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => addMessage(m))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, ({ old }) =>
        setMessages((prev) => prev.filter((m) => m.id !== old.id)),
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, ({ new: r }) =>
        applyReaction(r.message_id, r.user_id, r.emoji, true),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, ({ old: r }) =>
        applyReaction(r.message_id, r.user_id, r.emoji, false),
      )
      .on('presence', { event: 'sync' }, () => {
        const ids = new Set(Object.values(channel.presenceState()).flat().map((p) => p.user_id))
        setOnline([...ids])
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') channel.track({ user_id: myId })
      })

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [myId, addMessage, applyReaction, loadReactions, signUrls])

  async function loadOlder() {
    const oldest = messages[0]
    if (!oldest) return
    const { data } = await supabase
      .from('messages')
      .select('*')
      .lt('id', oldest.id)
      .order('id', { ascending: false })
      .limit(PAGE_SIZE)
    const rows = (data ?? []).reverse()
    const el = listRef.current
    preserveScroll.current = el.scrollHeight - el.scrollTop
    setMessages((prev) => [...rows, ...prev])
    setHasMore((data ?? []).length === PAGE_SIZE)
    loadReactions(rows.map((m) => m.id))
    signUrls(rows.map((m) => m.attachment_path))
  }

  // ---- scrolling -----------------------------------------------------------

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [])

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (preserveScroll.current != null) {
      el.scrollTop = el.scrollHeight - preserveScroll.current
      preserveScroll.current = null
    } else {
      scrollToBottom()
    }
  }, [messages, scrollToBottom])

  function onScroll() {
    const el = listRef.current
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  // ---- actions -------------------------------------------------------------

  async function send({ text, file }) {
    setError('')
    let attachment = {}
    if (file) {
      if (file.size > MAX_FILE_BYTES) {
        setError('Files must be 25 MB or smaller.')
        return false
      }
      const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file'
      const path = `${myId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream' })
      if (upErr) {
        setError(`Upload failed: ${upErr.message}`)
        return false
      }
      attachment = {
        attachment_path: path,
        attachment_name: file.name,
        attachment_type: file.type || null,
        attachment_size: file.size,
      }
    }
    const { data, error: insErr } = await supabase
      .from('messages')
      .insert({ content: text || null, ...attachment })
      .select()
      .single()
    if (insErr) {
      setError(insErr.message)
      if (attachment.attachment_path) supabase.storage.from(BUCKET).remove([attachment.attachment_path])
      return false
    }
    stickToBottom.current = true
    addMessage(data)
    return true
  }

  async function toggleReaction(messageId, emoji) {
    const mine = (reactions[messageId] ?? []).some((r) => r.user_id === myId && r.emoji === emoji)
    applyReaction(messageId, myId, emoji, !mine)
    const { error: err } = mine
      ? await supabase.from('reactions').delete().match({ message_id: messageId, user_id: myId, emoji })
      : await supabase.from('reactions').insert({ message_id: messageId, emoji })
    if (err) {
      applyReaction(messageId, myId, emoji, mine)
      setError(err.message)
    }
  }

  async function deleteMessage(msg) {
    if (!window.confirm('Delete this message for everyone?')) return
    const { error: err } = await supabase.from('messages').delete().eq('id', msg.id)
    if (err) return setError(err.message)
    setMessages((prev) => prev.filter((m) => m.id !== msg.id))
    if (msg.attachment_path) supabase.storage.from(BUCKET).remove([msg.attachment_path])
  }

  // ---- render --------------------------------------------------------------

  const items = useMemo(() => buildItems(messages), [messages])

  if (me === undefined) return <div className="splash">Loading…</div>
  if (me === null) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>No access</h1>
          <p className="muted">This account hasn&apos;t been added to the group chat. Ask the admin for a login.</p>
          <button className="primary" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  const memberIds = Object.keys(profiles)
  const headerFaces = [...memberIds.filter((id) => id !== myId), myId].slice(0, 3)

  return (
    <div className="chat">
      <header className="topbar">
        <button className="topbar-center" onClick={() => setShowMembers(true)}>
          <span className="group-avatar">
            {headerFaces.map((id) => (
              <Avatar key={id} name={profiles[id] ?? '?'} />
            ))}
          </span>
          <span className="people-pill">
            {memberIds.length} People <Chevron />
          </span>
        </button>
        <div className="topbar-sub">
          Group Chat{online.length > 0 && ` · ${online.length} online`}
        </div>
      </header>

      <main className="messages" ref={listRef} onScroll={onScroll} onClick={() => setPickerFor(null)}>
        {hasMore && (
          <button className="load-older" onClick={loadOlder}>
            Load earlier messages
          </button>
        )}
        {loading && <div className="empty">Loading messages…</div>}
        {!loading && !messages.length && <div className="empty">No messages yet. Say hi 👋</div>}
        {items.map((item) =>
          item.type === 'stamp' ? (
            <div key={item.key} className="stamp">
              <b>{item.day}</b> {item.time}
            </div>
          ) : (
            <Message
              key={item.msg.id}
              msg={item.msg}
              first={item.first}
              last={item.last}
              mine={item.msg.user_id === myId}
              myId={myId}
              username={profiles[item.msg.user_id] ?? '…'}
              profiles={profiles}
              reactions={reactions[item.msg.id] ?? []}
              url={urls[item.msg.attachment_path]}
              pickerOpen={pickerFor === item.msg.id}
              onOpenPicker={() => setPickerFor(item.msg.id)}
              onClosePicker={() => setPickerFor(null)}
              onReact={(emoji) => toggleReaction(item.msg.id, emoji)}
              onDelete={() => deleteMessage(item.msg)}
              onOpenImage={setLightbox}
              onMediaLoad={scrollToBottom}
            />
          ),
        )}
      </main>

      {error && (
        <div className="toast" onClick={() => setError('')}>
          {error}
        </div>
      )}

      <Composer onSend={send} />

      {showMembers && (
        <div className="sheet-backdrop" onClick={() => setShowMembers(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <span>{memberIds.length} People</span>
              <button className="sheet-done" onClick={() => setShowMembers(false)}>
                Done
              </button>
            </div>
            <ul className="member-list">
              {memberIds
                .sort((a, b) => (profiles[a] ?? '').localeCompare(profiles[b] ?? ''))
                .map((id) => (
                  <li key={id}>
                    <Avatar name={profiles[id]} />
                    <span className="member-name">
                      {profiles[id]}
                      {id === myId && <span className="muted"> (you)</span>}
                    </span>
                    {online.includes(id) && <span className="online-dot" title="Online" />}
                  </li>
                ))}
            </ul>
            <button className="sheet-signout" onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  )
}

function Message({
  msg,
  first,
  last,
  mine,
  myId,
  username,
  profiles,
  reactions,
  url,
  pickerOpen,
  onOpenPicker,
  onClosePicker,
  onReact,
  onDelete,
  onOpenImage,
  onMediaLoad,
}) {
  const pressTimer = useRef(null)
  const isImage = msg.attachment_type?.startsWith('image/')
  const isVideo = msg.attachment_type?.startsWith('video/')
  const isMedia = msg.attachment_path && (isImage || isVideo)
  const isFile = msg.attachment_path && !isMedia

  const grouped = useMemo(() => {
    const map = new Map()
    for (const r of reactions) {
      if (!map.has(r.emoji)) map.set(r.emoji, [])
      map.get(r.emoji).push(r.user_id)
    }
    return [...map.entries()]
  }, [reactions])
  const iReacted = reactions.some((r) => r.user_id === myId)

  // Long-press on touch, right-click or double-click on desktop opens tapbacks.
  const gestures = {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse') return
      pressTimer.current = setTimeout(onOpenPicker, LONG_PRESS_MS)
    },
    onPointerUp: () => clearTimeout(pressTimer.current),
    onPointerLeave: () => clearTimeout(pressTimer.current),
    onPointerCancel: () => clearTimeout(pressTimer.current),
    onContextMenu: (e) => {
      e.preventDefault()
      onOpenPicker()
    },
    onMouseDown: (e) => {
      if (e.detail > 1) e.preventDefault() // keep double-click from selecting text
    },
    onDoubleClick: () => {
      window.getSelection()?.removeAllRanges()
      onOpenPicker()
    },
  }

  const tail = (isLastPiece) => (last && isLastPiece ? 'tail' : '')

  return (
    <div
      className={`row ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''} ${grouped.length ? 'has-tapback' : ''}`}
    >
      {!mine && <div className="row-avatar">{last && <Avatar name={username} />}</div>}
      <div className="stack">
        {!mine && first && <div className="sender">{username}</div>}
        <div className="pieces" onClick={(e) => e.stopPropagation()} {...gestures}>
          {isMedia &&
            (url ? (
              isImage ? (
                <img
                  className="media"
                  src={url}
                  alt={msg.attachment_name}
                  onLoad={onMediaLoad}
                  onClick={() => onOpenImage(url)}
                />
              ) : (
                <video className="media" src={url} controls preload="metadata" onLoadedMetadata={onMediaLoad} />
              )
            ) : (
              <div className="media placeholder" />
            ))}
          {isFile && (
            <a
              className={`bubble file ${tail(!msg.content)}`}
              href={url ? `${url}&download=${encodeURIComponent(msg.attachment_name ?? 'file')}` : undefined}
              target="_blank"
              rel="noreferrer"
            >
              <FileIcon />
              <span className="file-info">
                <span className="file-name">{msg.attachment_name}</span>
                <span className="file-size">{formatSize(msg.attachment_size)}</span>
              </span>
            </a>
          )}
          {msg.content && (
            <div className={`bubble ${tail(true)}`} title={new Date(msg.created_at).toLocaleString()}>
              {linkify(msg.content)}
            </div>
          )}

          {grouped.length > 0 && (
            <button
              className={`tapback ${iReacted ? 'reacted' : ''}`}
              title={grouped
                .map(([e, users]) => `${e} ${users.map((u) => (u === myId ? 'You' : profiles[u] ?? '…')).join(', ')}`)
                .join('\n')}
              onClick={onOpenPicker}
            >
              {grouped.slice(0, 3).map(([e]) => (
                <span key={e}>{e}</span>
              ))}
              {reactions.length > 1 && <span className="tapback-count">{reactions.length}</span>}
            </button>
          )}

          <button className="react-hint" title="React" onClick={onOpenPicker}>
            <SmileIcon />
          </button>

          {pickerOpen && (
            <>
              <div className="tapback-bar">
                {TAPBACKS.map((e) => {
                  const on = reactions.some((r) => r.user_id === myId && r.emoji === e)
                  return (
                    <button
                      key={e}
                      className={on ? 'on' : ''}
                      onClick={() => {
                        onReact(e)
                        onClosePicker()
                      }}
                    >
                      {e}
                    </button>
                  )
                })}
              </div>
              {mine && (
                <div className="msg-menu">
                  <button
                    onClick={() => {
                      onClosePicker()
                      onDelete()
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Composer({ onSend }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const imageInput = useRef(null)
  const fileInput = useRef(null)
  const textRef = useRef(null)

  useEffect(() => {
    if (!file?.type.startsWith('image/')) return setPreview(null)
    const u = URL.createObjectURL(file)
    setPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  useEffect(() => {
    const el = textRef.current
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])

  const canSend = !busy && (text.trim() || file)

  async function submit(e) {
    e?.preventDefault()
    if (!canSend) return
    setBusy(true)
    const ok = await onSend({ text: text.trim(), file })
    setBusy(false)
    if (ok) {
      setText('')
      setFile(null)
      textRef.current?.focus()
    }
  }

  function pick(e) {
    const f = e.target.files?.[0]
    if (f) setFile(f)
    e.target.value = ''
    setMenu(false)
  }

  function onPaste(e) {
    const f = [...(e.clipboardData?.files ?? [])][0]
    if (f) {
      e.preventDefault()
      setFile(f)
    }
  }

  return (
    <form
      className="composer"
      onSubmit={submit}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files?.[0]
        if (f) setFile(f)
      }}
    >
      <div className="plus-wrap">
        <button type="button" className="circle-btn" aria-label="Add photo or file" onClick={() => setMenu((m) => !m)}>
          <PlusIcon />
        </button>
        {menu && (
          <div className="plus-menu">
            <button type="button" onClick={() => imageInput.current.click()}>
              <span className="plus-menu-icon photos">🖼️</span> Photos
            </button>
            <button type="button" onClick={() => fileInput.current.click()}>
              <span className="plus-menu-icon files">📎</span> File
            </button>
          </div>
        )}
      </div>
      <input ref={imageInput} type="file" accept="image/*,video/*" hidden onChange={pick} />
      <input ref={fileInput} type="file" hidden onChange={pick} />

      <div className={`input-pill ${file ? 'with-file' : ''}`}>
        {file && (
          <div className="pending">
            {preview ? (
              <img src={preview} alt="" />
            ) : (
              <div className="pending-file">
                <FileIcon />
                <span className="file-info">
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatSize(file.size)}</span>
                </span>
              </div>
            )}
            <button type="button" className="pending-remove" onClick={() => setFile(null)} aria-label="Remove">
              ✕
            </button>
          </div>
        )}
        <div className="input-row">
          <textarea
            ref={textRef}
            rows={1}
            placeholder="Message"
            value={text}
            onFocus={() => setMenu(false)}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
            }}
          />
          {canSend || busy ? (
            <button className="send-btn" aria-label="Send" disabled={!canSend}>
              {busy ? <span className="spinner" /> : <ArrowUpIcon />}
            </button>
          ) : null}
        </div>
      </div>
    </form>
  )
}

function Avatar({ name }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span
      className="avatar"
      style={{ background: `linear-gradient(180deg, hsl(${hue} 55% 68%), hsl(${hue} 50% 48%))` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

// ---- icons ------------------------------------------------------------------

const Chevron = () => (
  <svg className="chevron" viewBox="0 0 8 14" aria-hidden="true">
    <path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)
const ArrowUpIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const SmileIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M8.5 14.5c1.8 2 5.2 2 7 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="9" cy="10" r="1.2" fill="currentColor" />
    <circle cx="15" cy="10" r="1.2" fill="currentColor" />
  </svg>
)
const FileIcon = () => (
  <svg className="file-icon" viewBox="0 0 24 30" aria-hidden="true">
    <path d="M3 1h12l8 8v18a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="#fff" stroke="#c7c7cc" />
    <path d="M15 1v6a2 2 0 0 0 2 2h6" fill="#e5e5ea" stroke="#c7c7cc" />
  </svg>
)

// ---- helpers ----------------------------------------------------------------

function buildItems(messages) {
  const items = []
  let prev = null
  for (const msg of messages) {
    const d = new Date(msg.created_at)
    const gap = prev ? d - new Date(prev.created_at) : Infinity
    const newDay = !prev || new Date(prev.created_at).toDateString() !== d.toDateString()
    const stamp = newDay || gap > STAMP_GAP_MS
    if (stamp) items.push({ type: 'stamp', key: `stamp-${msg.id}`, ...formatStamp(d) })
    const first = stamp || prev.user_id !== msg.user_id || gap > GROUP_WINDOW_MS
    items.push({ type: 'msg', msg, first })
    prev = msg
  }
  items.forEach((item, i) => {
    if (item.type !== 'msg') return
    const next = items[i + 1]
    item.last = !next || next.type !== 'msg' || next.first
  })
  return items
}

function formatStamp(d) {
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return { day: 'Today', time }
  if (d.toDateString() === yesterday.toDateString()) return { day: 'Yesterday', time }
  if (today - d < 6 * 24 * 60 * 60 * 1000) return { day: d.toLocaleDateString(undefined, { weekday: 'long' }), time }
  return { day: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), time: `at ${time}` }
}

function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function linkify(text) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  )
}
