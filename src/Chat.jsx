import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { supabase, BUCKET } from './supabase.js'

const PAGE_SIZE = 100
const MAX_FILE_BYTES = 25 * 1024 * 1024
const URL_TTL_SECONDS = 60 * 60 * 12
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👏']
const GROUP_WINDOW_MS = 5 * 60 * 1000

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
  const [activeId, setActiveId] = useState(null)
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
    if (!window.confirm('Delete this message?')) return
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

  const memberCount = Object.keys(profiles).length

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="room">
          <div className="room-icon">💬</div>
          <div>
            <div className="room-name">Group Chat</div>
            <div className="room-meta">
              {memberCount} members · <span className="online-dot" /> {online.length} online
            </div>
          </div>
        </div>
        <div className="me">
          <Avatar name={me.username} small />
          <span className="me-name">{me.username}</span>
          <button className="ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="messages" ref={listRef} onScroll={onScroll} onClick={() => setActiveId(null)}>
        {hasMore && (
          <button className="load-older" onClick={loadOlder}>
            Load earlier messages
          </button>
        )}
        {loading && <div className="empty">Loading messages…</div>}
        {!loading && !messages.length && <div className="empty">No messages yet. Say hi 👋</div>}
        {items.map((item) =>
          item.type === 'day' ? (
            <div key={item.key} className="day">
              <span>{item.label}</span>
            </div>
          ) : (
            <Message
              key={item.msg.id}
              msg={item.msg}
              compact={item.compact}
              mine={item.msg.user_id === myId}
              myId={myId}
              username={profiles[item.msg.user_id] ?? '…'}
              profiles={profiles}
              reactions={reactions[item.msg.id] ?? []}
              url={urls[item.msg.attachment_path]}
              active={activeId === item.msg.id}
              onActivate={() => setActiveId(item.msg.id)}
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
          {error} <span className="muted">(tap to dismiss)</span>
        </div>
      )}

      <Composer onSend={send} />

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
  compact,
  mine,
  myId,
  username,
  profiles,
  reactions,
  url,
  active,
  onActivate,
  onReact,
  onDelete,
  onOpenImage,
  onMediaLoad,
}) {
  const [picker, setPicker] = useState(false)
  const isImage = msg.attachment_type?.startsWith('image/')
  const isVideo = msg.attachment_type?.startsWith('video/')

  const grouped = useMemo(() => {
    const map = new Map()
    for (const r of reactions) {
      if (!map.has(r.emoji)) map.set(r.emoji, [])
      map.get(r.emoji).push(r.user_id)
    }
    return [...map.entries()]
  }, [reactions])

  return (
    <div
      className={`msg ${mine ? 'mine' : ''} ${compact ? 'compact' : ''} ${active ? 'active' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onActivate()
      }}
      onMouseLeave={() => setPicker(false)}
    >
      <div className="msg-avatar">{!compact && !mine && <Avatar name={username} />}</div>
      <div className="msg-body">
        {!compact && (
          <div className="msg-head">
            <span className="msg-author">{mine ? 'You' : username}</span>
            <span className="msg-time">{formatTime(msg.created_at)}</span>
          </div>
        )}
        <div className="bubble-row">
          <div className="bubble" title={new Date(msg.created_at).toLocaleString()}>
            {msg.attachment_path &&
              (isImage ? (
                url ? (
                  <img className="attachment-img" src={url} alt={msg.attachment_name} onLoad={onMediaLoad} onClick={() => onOpenImage(url)} />
                ) : (
                  <div className="attachment-placeholder">Loading image…</div>
                )
              ) : isVideo && url ? (
                <video className="attachment-img" src={url} controls preload="metadata" onLoadedMetadata={onMediaLoad} />
              ) : (
                <a
                  className="file-card"
                  href={url ? `${url}&download=${encodeURIComponent(msg.attachment_name ?? 'file')}` : undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="file-icon">📄</span>
                  <span className="file-info">
                    <span className="file-name">{msg.attachment_name}</span>
                    <span className="file-size">{formatSize(msg.attachment_size)} · Download</span>
                  </span>
                </a>
              ))}
            {msg.content && <div className="text">{linkify(msg.content)}</div>}
          </div>
          <div className="actions">
            <button className="icon-btn" title="React" onClick={() => setPicker((p) => !p)}>
              😊
            </button>
            {mine && (
              <button className="icon-btn" title="Delete" onClick={onDelete}>
                🗑️
              </button>
            )}
            {picker && (
              <div className="picker">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      onReact(e)
                      setPicker(false)
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {grouped.length > 0 && (
          <div className="reactions">
            {grouped.map(([emoji, users]) => (
              <button
                key={emoji}
                className={`reaction ${users.includes(myId) ? 'reacted' : ''}`}
                title={users.map((u) => (u === myId ? 'You' : profiles[u] ?? '…')).join(', ')}
                onClick={() => onReact(emoji)}
              >
                {emoji} <span>{users.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Composer({ onSend }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
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
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  async function submit(e) {
    e?.preventDefault()
    const trimmed = text.trim()
    if (busy || (!trimmed && !file)) return
    setBusy(true)
    const ok = await onSend({ text: trimmed, file })
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
      {file && (
        <div className="pending">
          {preview ? <img src={preview} alt="" /> : <span className="file-icon">📄</span>}
          <span className="file-info">
            <span className="file-name">{file.name}</span>
            <span className="file-size">{formatSize(file.size)}</span>
          </span>
          <button type="button" className="icon-btn" onClick={() => setFile(null)} title="Remove">
            ✕
          </button>
        </div>
      )}
      <div className="composer-row">
        <button type="button" className="icon-btn big" title="Send a photo" onClick={() => imageInput.current.click()}>
          🖼️
        </button>
        <button type="button" className="icon-btn big" title="Attach a file" onClick={() => fileInput.current.click()}>
          📎
        </button>
        <input ref={imageInput} type="file" accept="image/*,video/*" hidden onChange={pick} />
        <input ref={fileInput} type="file" hidden onChange={pick} />
        <textarea
          ref={textRef}
          rows={1}
          placeholder="Write a message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
          }}
        />
        <button className="primary send" disabled={busy || (!text.trim() && !file)}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </form>
  )
}

function Avatar({ name, small }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <div className={`avatar ${small ? 'small' : ''}`} style={{ background: `hsl(${hue} 60% 45%)` }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  )
}

// ---- helpers ----------------------------------------------------------------

function buildItems(messages) {
  const items = []
  let prev = null
  for (const msg of messages) {
    const d = new Date(msg.created_at)
    const dayKey = d.toDateString()
    if (!prev || new Date(prev.created_at).toDateString() !== dayKey) {
      items.push({ type: 'day', key: `day-${dayKey}`, label: formatDay(d) })
      prev = null
    }
    const compact = prev && prev.user_id === msg.user_id && d - new Date(prev.created_at) < GROUP_WINDOW_MS
    items.push({ type: 'msg', msg, compact })
    prev = msg
  }
  return items
}

function formatDay(d) {
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
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
