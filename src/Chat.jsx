import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { supabase, BUCKET, AVATAR_BUCKET, avatarUrl } from './supabase.js'
import Splash from './Splash.jsx'
import { playPop, playReceive, playSend, setSoundsEnabled, soundsEnabled, unlockAudio } from './sounds.js'

const PAGE_SIZE = 100
const MAX_FILE_BYTES = 25 * 1024 * 1024
const URL_TTL_SECONDS = 60 * 60 * 12
const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓', '🔥']
const GROUP_WINDOW_MS = 5 * 60 * 1000
const STAMP_GAP_MS = 15 * 60 * 1000
const LONG_PRESS_MS = 450
const AVATAR_PX = 256

export default function Chat({ session }) {
  const myId = session.user.id
  const [me, setMe] = useState(undefined)
  const [profiles, setProfiles] = useState({})
  const [avatars, setAvatars] = useState({})
  const [messages, setMessages] = useState([])
  const [reactions, setReactions] = useState({})
  const [urls, setUrls] = useState({})
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState([])
  const [error, setError] = useState('')
  const [pickerFor, setPickerFor] = useState(null)
  const [showMembers, setShowMembers] = useState(false)
  const [view, setView] = useState({ type: 'group' })
  const [showPanel, setShowPanel] = useState(false)
  const [dmPeers, setDmPeers] = useState([])
  const [ownerPairs, setOwnerPairs] = useState([])
  const [lightbox, setLightbox] = useState(null)
  const [sounds, setSounds] = useState(soundsEnabled)

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

  // ---- conversations -------------------------------------------------------
  // view is { type: 'group' }, { type: 'dm', peerId }, or
  // { type: 'owner', aId, bId } for a read-only owner view of a private
  // chat between two other members. The owner never appears as a
  // participant in an owner view.
  const isGroup = view.type === 'group'
  const peerId = view.type === 'dm' ? view.peerId : null
  const isOwnerView = view.type === 'owner'
  const ownerA = isOwnerView ? view.aId : null
  const ownerB = isOwnerView ? view.bId : null
  const viewRef = useRef(view)
  viewRef.current = view

  // The owner is detected by profile username, never by a hardcoded UUID.
  const isOwner = me?.username === 'mubarak'

  const pairKey = (a, b) => [a, b].sort().join('|')

  const isMessageForView = useCallback(
    (msg, v) => {
      if (v.type === 'group') return msg.recipient_id == null
      if (v.type === 'owner') {
        return (
          (msg.user_id === v.aId && msg.recipient_id === v.bId) ||
          (msg.user_id === v.bId && msg.recipient_id === v.aId)
        )
      }
      return (
        (msg.user_id === myId && msg.recipient_id === v.peerId) ||
        (msg.user_id === v.peerId && msg.recipient_id === myId)
      )
    },
    [myId],
  )

  const dmPeerOf = useCallback(
    (msg) => {
      if (msg.recipient_id == null) return null
      if (msg.user_id === myId) return msg.recipient_id
      if (msg.recipient_id === myId) return msg.user_id
      return null
    },
    [myId],
  )

  const addDmPeer = useCallback((id) => {
    if (!id || id === myId) return
    setDmPeers((prev) => (prev.includes(id) ? prev : [...prev, id]))
  }, [myId])

  // Owner pairs are private chats between two other members. Pairs that
  // include the owner are already listed under Direct messages, so they
  // are not duplicated here.
  const addOwnerPair = useCallback(
    (a, b) => {
      if (!a || !b || a === b || a === myId || b === myId) return
      const key = pairKey(a, b)
      setOwnerPairs((prev) => (prev.some((p) => pairKey(p[0], p[1]) === key) ? prev : [...prev, [a, b].sort()]))
    },
    [myId],
  )

  function filterConversation(query, v) {
    if (v.type === 'group') return query.is('recipient_id', null)
    if (v.type === 'owner') {
      return query.or(
        `and(user_id.eq.${v.aId},recipient_id.eq.${v.bId}),and(user_id.eq.${v.bId},recipient_id.eq.${v.aId})`,
      )
    }
    return query.or(
      `and(user_id.eq.${myId},recipient_id.eq.${v.peerId}),and(user_id.eq.${v.peerId},recipient_id.eq.${myId})`,
    )
  }

  function openDm(id) {
    addDmPeer(id)
    setView({ type: 'dm', peerId: id })
    setShowMembers(false)
    setShowPanel(false)
  }

  function openOwner(a, b) {
    const [first, second] = [a, b].sort()
    setView({ type: 'owner', aId: first, bId: second })
    setShowMembers(false)
    setShowPanel(false)
  }

  function openGroup() {
    setView({ type: 'group' })
    setShowPanel(false)
  }

  const ensureProfile = useCallback(async (userId) => {
    if (profilesRef.current[userId]) return
    const { data } = await supabase.from('profiles').select('id, username, avatar_path').eq('id', userId).single()
    if (data) applyProfile(data)
  }, [])

  const applyProfile = (row) => {
    setProfiles((p) => ({ ...p, [row.id]: row.username }))
    setAvatars((a) => ({ ...a, [row.id]: avatarUrl(row.avatar_path) }))
  }

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
      const [{ data: meRow }, { data: profileRows }, { data: dmRows, error: dmErr }] = await Promise.all([
        supabase.from('profiles').select('id, username').eq('id', myId).maybeSingle(),
        supabase.from('profiles').select('id, username, avatar_path'),
        supabase
          .from('messages')
          .select('user_id, recipient_id')
          .not('recipient_id', 'is', null)
          .or(`user_id.eq.${myId},recipient_id.eq.${myId}`)
          .limit(1000),
      ])
      if (cancelled) return
      setMe(meRow ?? null)
      if (!meRow) return setLoading(false)
      if (dmErr) setError(dmErr.message)
      setProfiles(Object.fromEntries((profileRows ?? []).map((p) => [p.id, p.username])))
      setAvatars(Object.fromEntries((profileRows ?? []).map((p) => [p.id, avatarUrl(p.avatar_path)])))
      // Peers the user already has a DM conversation with, from message history.
      const peers = new Set()
      for (const row of dmRows ?? []) {
        if (row.user_id === myId && row.recipient_id) peers.add(row.recipient_id)
        else if (row.recipient_id === myId) peers.add(row.user_id)
      }
      setDmPeers([...peers])
      // Owner only: every private-chat pair between other members, from
      // message history the owner can read once migration 0004 is applied.
      // Before that migration, this query is still limited by the 0003
      // policies, so it simply returns the owner's own pairs, which are
      // filtered out below and never shown in the owner section.
      if (meRow?.username === 'mubarak') {
        const { data: allDmRows } = await supabase
          .from('messages')
          .select('user_id, recipient_id')
          .not('recipient_id', 'is', null)
          .limit(1000)
        const pairs = new Map()
        for (const row of allDmRows ?? []) {
          if (!row.user_id || !row.recipient_id || row.user_id === row.recipient_id) continue
          if (row.user_id === myId || row.recipient_id === myId) continue
          pairs.set(pairKey(row.user_id, row.recipient_id), [row.user_id, row.recipient_id].sort())
        }
        setOwnerPairs([...pairs.values()])
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [myId])

  // Escape closes the side panel, like tapping its backdrop or close button.
  useEffect(() => {
    if (!showPanel) return
    const onKey = (e) => {
      if (e.key === 'Escape') setShowPanel(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showPanel])

  // Load the currently selected conversation (group or one DM) from scratch.
  useEffect(() => {
    if (me === undefined || me === null) return
    let cancelled = false
    setLoading(true)
    setMessages([])
    setHasMore(false)
    stickToBottom.current = true
    async function load() {
      const { data: msgRows, error: msgErr } = await filterConversation(
        supabase.from('messages').select('*').order('id', { ascending: false }).limit(PAGE_SIZE),
        view,
      )
      if (cancelled) return
      if (msgErr) setError(msgErr.message)
      const rows = (msgRows ?? []).reverse()
      setMessages(rows)
      setHasMore((msgRows ?? []).length === PAGE_SIZE)
      setLoading(false)
      loadReactions(rows.map((m) => m.id))
      signUrls(rows.map((m) => m.attachment_path))
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, view])

  useEffect(() => {
    const channel = supabase
      .channel('group-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => {
        const peer = dmPeerOf(m)
        if (peer) {
          // A DM for a peer not currently being viewed still adds that peer
          // to the side panel list, without leaking the message into the
          // current view.
          addDmPeer(peer)
          ensureProfile(m.user_id)
          if (!isMessageForView(m, viewRef.current)) {
            if (m.user_id !== myId) playReceive()
            return
          }
        } else if (m.recipient_id != null) {
          // A DM between two other members: it belongs in the owner's
          // list only, never in the group view or a participant's DM view,
          // and it never names the owner as a participant.
          if (viewRef.current.type === 'owner' && isMessageForView(m, viewRef.current)) {
            playReceive()
            addMessage(m)
            return
          }
          addOwnerPair(m.user_id, m.recipient_id)
          ensureProfile(m.user_id)
          return
        } else if (!isMessageForView(m, viewRef.current)) {
          return
        }
        if (m.user_id !== myId) playReceive()
        addMessage(m)
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, ({ old }) =>
        setMessages((prev) => prev.filter((m) => m.id !== old.id)),
      )
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, ({ new: r }) =>
        applyReaction(r.message_id, r.user_id, r.emoji, true),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, ({ old: r }) =>
        applyReaction(r.message_id, r.user_id, r.emoji, false),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, ({ new: row }) => {
        if (row?.id) applyProfile(row)
      })
      .on('presence', { event: 'sync' }, () => {
        const ids = new Set(Object.values(channel.presenceState()).flat().map((p) => p.user_id))
        setOnline([...ids])
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') channel.track({ user_id: myId })
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [myId, addMessage, applyReaction, dmPeerOf, addDmPeer, addOwnerPair, ensureProfile, isMessageForView])

  async function loadOlder() {
    const oldest = messages[0]
    if (!oldest) return
    const { data } = await filterConversation(
      supabase
        .from('messages')
        .select('*')
        .lt('id', oldest.id)
        .order('id', { ascending: false })
        .limit(PAGE_SIZE),
      view,
    )
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

  // Audio can only start after a user gesture; keep the last messages in view
  // when the keyboard opens or the window resizes.
  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('keydown', unlockAudio)
    window.addEventListener('app-viewport', scrollToBottom)
    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
      window.removeEventListener('app-viewport', scrollToBottom)
    }
  }, [scrollToBottom])

  function onScroll() {
    const el = listRef.current
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  // ---- actions -------------------------------------------------------------

  async function send({ text, file }) {
    // Owner view is read-only; the composer is hidden there, and this is
    // the second line of defence if send is ever called from that view.
    if (viewRef.current.type === 'owner') return false
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
      .insert({ content: text || null, recipient_id: peerId, ...attachment })
      .select()
      .single()
    if (insErr) {
      setError(insErr.message)
      if (attachment.attachment_path) supabase.storage.from(BUCKET).remove([attachment.attachment_path])
      return false
    }
    stickToBottom.current = true
    playSend()
    addMessage(data)
    return true
  }

  async function toggleReaction(messageId, emoji) {
    if (viewRef.current.type === 'owner') return
    const mine = (reactions[messageId] ?? []).some((r) => r.user_id === myId && r.emoji === emoji)
    applyReaction(messageId, myId, emoji, !mine)
    if (!mine) playPop()
    const { error: err } = mine
      ? await supabase.from('reactions').delete().match({ message_id: messageId, user_id: myId, emoji })
      : await supabase.from('reactions').insert({ message_id: messageId, emoji })
    if (err) {
      applyReaction(messageId, myId, emoji, mine)
      setError(err.message)
    }
  }

  async function changeAvatar(file) {
    setError('')
    let blob
    try {
      blob = await squareImage(file, AVATAR_PX)
    } catch {
      return setError('That image could not be read. Try a JPEG or PNG.')
    }
    const path = `${myId}/${Date.now()}.jpg`
    const { error: upErr } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, blob, { contentType: 'image/jpeg' })
    if (upErr) return setError(`Upload failed: ${upErr.message}`)
    await setAvatarPath(path)
  }

  async function setAvatarPath(path) {
    const { data: old } = await supabase.from('profiles').select('avatar_path').eq('id', myId).single()
    const { error: err } = await supabase.from('profiles').update({ avatar_path: path }).eq('id', myId)
    if (err) {
      if (path) supabase.storage.from(AVATAR_BUCKET).remove([path])
      return setError(err.message)
    }
    setAvatars((a) => ({ ...a, [myId]: avatarUrl(path) }))
    if (old?.avatar_path && old.avatar_path !== path) supabase.storage.from(AVATAR_BUCKET).remove([old.avatar_path])
  }

  async function deleteMessage(msg) {
    if (viewRef.current.type === 'owner') return
    if (!window.confirm('Delete this message for everyone?')) return
    const { error: err } = await supabase.from('messages').delete().eq('id', msg.id)
    if (err) return setError(err.message)
    setMessages((prev) => prev.filter((m) => m.id !== msg.id))
    if (msg.attachment_path) supabase.storage.from(BUCKET).remove([msg.attachment_path])
  }

  // ---- render --------------------------------------------------------------

  const items = useMemo(() => buildItems(messages), [messages])

  if (me === undefined) return <Splash />
  if (me === null) {
    return (
      <div className="login-page">
        <div className="login-card">
          <img className="login-logo" src="/logo.png" alt="" />
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
  const peerName = peerId ? profiles[peerId] ?? '…' : null
  const ownerNameA = ownerA ? profiles[ownerA] ?? '…' : null
  const ownerNameB = ownerB ? profiles[ownerB] ?? '…' : null
  const ownerPairLabel = isOwnerView ? `${ownerNameA} and ${ownerNameB}` : null
  const dmList = dmPeers
    .filter((id) => profiles[id])
    .sort((a, b) => (profiles[a] ?? '').localeCompare(profiles[b] ?? ''))
  const ownerPairList = ownerPairs
    .filter(([a, b]) => profiles[a] && profiles[b])
    .sort((p, q) => `${profiles[p[0]]} and ${profiles[p[1]]}`.localeCompare(`${profiles[q[0]]} and ${profiles[q[1]]}`))

  return (
    <div className="chat">
      <header className="topbar">
        {isGroup ? (
          <button className="topbar-btn left" onClick={() => setShowPanel(true)} aria-label="Open chats">
            ☰ Chats
          </button>
        ) : (
          <>
            <button className="topbar-btn left" onClick={openGroup} aria-label="Back to Group Chat">
              ‹ Back
            </button>
            <button className="topbar-btn right" onClick={() => setShowPanel(true)} aria-label="Open chats">
              ☰ Chats
            </button>
          </>
        )}
        {isGroup ? (
          <button className="topbar-center" onClick={() => setShowMembers(true)}>
            <span className="group-avatar">
              {headerFaces.map((id) => (
                <Avatar key={id} name={profiles[id] ?? '?'} src={avatars[id]} />
              ))}
            </span>
            <span className="people-pill">
              {memberIds.length} People <Chevron />
            </span>
          </button>
        ) : isOwnerView ? (
          <button className="topbar-center" onClick={() => setShowMembers(true)}>
            <span className="group-avatar">
              <Avatar name={ownerNameA} src={avatars[ownerA]} />
              <Avatar name={ownerNameB} src={avatars[ownerB]} />
            </span>
            <span className="people-pill">{ownerPairLabel}</span>
          </button>
        ) : (
          <button className="topbar-center" onClick={() => setShowMembers(true)}>
            <span className="group-avatar">
              <Avatar name={peerName} src={avatars[peerId]} />
            </span>
            <span className="people-pill">{peerName}</span>
          </button>
        )}
        <div className="topbar-sub">
          {isGroup
            ? `Group Chat${online.length > 0 ? ` · ${online.length} online` : ''}`
            : isOwnerView
              ? `Owner view · ${ownerPairLabel}`
              : `Private chat · only you and ${peerName}`}
        </div>
      </header>

      <main className="messages" ref={listRef} onScroll={onScroll} onClick={() => setPickerFor(null)}>
        {hasMore && (
          <button className="load-older" onClick={loadOlder}>
            Load earlier messages
          </button>
        )}
        {loading && <div className="empty">Loading messages…</div>}
        {!loading && !messages.length && (
          <div className="empty">
            <img className="empty-logo" src="/logo.png" alt="" />
            {isGroup ? (
              <>No messages yet. Say hi 👋</>
            ) : isOwnerView ? (
              <>No messages in this private chat between {ownerPairLabel}.</>
            ) : (
              <>No messages yet. This is a private chat between you and {peerName}.</>
            )}
          </div>
        )}
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
              readOnly={isOwnerView}
              myId={myId}
              username={profiles[item.msg.user_id] ?? '…'}
              avatar={avatars[item.msg.user_id]}
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

      {isOwnerView ? (
        <div className="owner-readonly" role="note">
          Read-only owner view · you cannot send, react, or delete here.
        </div>
      ) : (
        <Composer onSend={send} placeholder={isGroup ? 'Message' : `Message ${peerName}`} />
      )}

      {showPanel && (
        <div className="panel-backdrop" onClick={() => setShowPanel(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <span>Chats</span>
              <button className="panel-close" onClick={() => setShowPanel(false)} aria-label="Close chats">
                ✕
              </button>
            </div>
            <button className={`dm-entry ${isGroup ? 'active' : ''}`} onClick={openGroup}>
              <span className="group-avatar">
                {headerFaces.map((id) => (
                  <Avatar key={id} name={profiles[id] ?? '?'} src={avatars[id]} />
                ))}
              </span>
              <span className="dm-name">Group Chat</span>
              {online.length > 0 && <span className="dm-meta">{online.length} online</span>}
            </button>
            <div className="panel-section">Direct messages</div>
            {dmList.length === 0 ? (
              <div className="panel-empty muted">
                No direct chats yet. Use Chat with in People to start one.
              </div>
            ) : (
              <ul className="dm-list">
                {dmList.map((id) => (
                  <li key={id}>
                    <button
                      className={`dm-entry ${!isGroup && peerId === id ? 'active' : ''}`}
                      aria-label={`Chat with ${profiles[id]}${online.includes(id) ? ' (online)' : ''}`}
                      onClick={() => openDm(id)}
                    >
                      <Avatar name={profiles[id]} src={avatars[id]} />
                      <span className="dm-name">{profiles[id]}</span>
                      {online.includes(id) && <span className="online-dot" title="Online" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {isOwner && (
              <>
                <div className="panel-section">Owner view</div>
                {ownerPairList.length === 0 ? (
                  <div className="panel-empty muted">
                    No private chats between other members yet.
                  </div>
                ) : (
                  <ul className="dm-list">
                    {ownerPairList.map(([a, b]) => {
                      const label = `${profiles[a]} and ${profiles[b]}`
                      return (
                        <li key={pairKey(a, b)}>
                          <button
                            className={`dm-entry ${isOwnerView && ownerA === a && ownerB === b ? 'active' : ''}`}
                            aria-label={`Owner view: ${label}`}
                            onClick={() => openOwner(a, b)}
                          >
                            <span className="group-avatar">
                              <Avatar name={profiles[a]} src={avatars[a]} />
                              <Avatar name={profiles[b]} src={avatars[b]} />
                            </span>
                            <span className="dm-name">{label}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showMembers && (
        <div className="sheet-backdrop" onClick={() => setShowMembers(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <span>{memberIds.length} People</span>
              <button className="sheet-done" onClick={() => setShowMembers(false)}>
                Done
              </button>
            </div>
            <MyPhoto
              name={me.username}
              src={avatars[myId]}
              onPick={changeAvatar}
              onRemove={() => setAvatarPath(null)}
            />
            <ul className="member-list">
              {memberIds
                .sort((a, b) => (profiles[a] ?? '').localeCompare(profiles[b] ?? ''))
                .map((id) => (
                  <li key={id}>
                    <Avatar name={profiles[id]} src={avatars[id]} />
                    <span className="member-name">
                      {profiles[id]}
                      {id === myId && <span className="muted"> (you)</span>}
                    </span>
                    {online.includes(id) && <span className="online-dot" title="Online" />}
                    {id !== myId && (
                      <button className="chat-with" onClick={() => openDm(id)}>
                        Chat with
                      </button>
                    )}
                  </li>
                ))}
            </ul>
            <label className="setting-row">
              <span>Sounds</span>
              <input
                type="checkbox"
                className="switch"
                checked={sounds}
                onChange={(e) => {
                  setSoundsEnabled(e.target.checked)
                  setSounds(e.target.checked)
                  if (e.target.checked) {
                    unlockAudio()
                    playReceive()
                  }
                }}
              />
            </label>
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
  readOnly = false,
  myId,
  username,
  avatar,
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
  // In a read-only owner view, no gesture opens the reaction picker.
  const gestures = readOnly
    ? {}
    : {
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
      {!mine && <div className="row-avatar">{last && <Avatar name={username} src={avatar} />}</div>}
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
              onClick={readOnly ? undefined : onOpenPicker}
            >
              {grouped.slice(0, 3).map(([e]) => (
                <span key={e}>{e}</span>
              ))}
              {reactions.length > 1 && <span className="tapback-count">{reactions.length}</span>}
            </button>
          )}

          {!readOnly && (
            <button className="react-hint" title="React" onClick={onOpenPicker}>
              <SmileIcon />
            </button>
          )}

          {pickerOpen && !readOnly && (
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

function Composer({ onSend, placeholder = 'Message' }) {
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
            placeholder={placeholder}
            value={text}
            onFocus={() => setMenu(false)}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
            }}
          />
          {canSend || busy ? (
            <button
              className="send-btn"
              aria-label="Send"
              disabled={!canSend}
              onPointerDown={(e) => e.preventDefault()}
            >
              {busy ? <span className="spinner" /> : <ArrowUpIcon />}
            </button>
          ) : null}
        </div>
      </div>
    </form>
  )
}

function MyPhoto({ name, src, onPick, onRemove }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(false)

  async function pick(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setBusy(true)
    await onPick(f)
    setBusy(false)
  }

  return (
    <div className="my-photo">
      <button className="my-photo-avatar" onClick={() => input.current.click()} aria-label="Change photo">
        <Avatar name={name} src={src} />
        {busy && <span className="my-photo-busy"><span className="spinner" /></span>}
      </button>
      <div className="my-photo-name">{name}</div>
      <div className="my-photo-actions">
        <button onClick={() => input.current.click()} disabled={busy}>
          {src ? 'Change Photo' : 'Add Photo'}
        </button>
        {src && (
          <button className="danger" onClick={onRemove} disabled={busy}>
            Remove
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={pick} />
    </div>
  )
}

function Avatar({ name, src }) {
  if (src) return <img className="avatar" src={src} alt="" />
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

// Center-crop an image file to a square JPEG of the given size.
async function squareImage(file, size) {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  canvas
    .getContext('2d')
    .drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.88),
  )
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
