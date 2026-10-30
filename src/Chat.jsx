import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { supabase, BUCKET, AVATAR_BUCKET, avatarUrl } from './supabase.js'
import Splash from './Splash.jsx'
import ChatList, { listPreview, listTime } from './ChatList.jsx'
import GroupSheet from './Groups.jsx'
import ApiKeys from './ApiKeys.jsx'
import { useTyping } from './typing.js'
import { VoicePlayer, VoiceRecorder, MicIcon, canRecordVoice, formatDuration } from './Voice.jsx'
import MediaViewer from './MediaViewer.jsx'
// The call screen (and the realtime SDK) only loads when a call starts.
const CallScreen = lazy(() => import('./CallScreen.jsx'))
import { prepareForUpload, uploadWithProgress, saveMedia, imageLinksIn, withoutMarkdownImages } from './media.js'
import { playPop, playReceive, playSend, setSoundsEnabled, soundsEnabled, unlockAudio } from './sounds.js'

const PAGE_SIZE = 100
const MAX_FILE_BYTES = 25 * 1024 * 1024
const URL_TTL_SECONDS = 60 * 60 * 12
const TAPBACKS = ['❤️', '👍', '👎', '😂', '‼️', '❓', '🔥']
const GROUP_WINDOW_MS = 5 * 60 * 1000
const STAMP_GAP_MS = 15 * 60 * 1000
const LONG_PRESS_MS = 450
const AVATAR_PX = 256
const WIDE_QUERY = '(min-width: 900px)'
const PREVIEW_FIELDS = 'id, user_id, recipient_id, content, attachment_path, attachment_name, attachment_type, call_duration, created_at'

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
  // Online = has the app open (realtime presence) or used the API recently
  // (AI agents); see onlineIds below.
  const [presenceIds, setOnline] = useState([])
  const [lastSeen, setLastSeen] = useState({}) // user id -> ms of last API activity
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  const [error, setError] = useState('')
  const [pickerFor, setPickerFor] = useState(null)
  const [showMembers, setShowMembers] = useState(false)
  // A push notification that opens the app carries the conversation in
  // the URL (?view=dm&peer=… or ?view=owner&a=…&b=…), so a cold start
  // from a lock-screen tap lands in the right conversation, not just the
  // group chat. Panel navigation does not rewrite the URL.
  const [view, setView] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('view') === 'dm' && params.get('peer')) return { type: 'dm', peerId: params.get('peer') }
      if (params.get('view') === 'group' && params.get('group')) return { type: 'group', groupId: params.get('group') }
      if (params.get('view') === 'owner' && params.get('a') && params.get('b')) {
        return { type: 'owner', aId: params.get('a'), bId: params.get('b') }
      }
    } catch {
      // ignore a malformed URL and start in the group chat
    }
    return { type: 'group' }
  })
  // Phones show one screen at a time: the chat list, or the open chat sliding
  // over it. Wide screens show both side by side, so a chat is always open.
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE_QUERY).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE_QUERY)
    if (!mq) return
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const [screen, setScreen] = useState(() =>
    new URLSearchParams(window.location.search).get('view') ? 'chat' : 'list',
  )
  // The chat counts as "being read" only while it is on screen.
  const chatActive = wide || screen === 'chat'
  const activeRef = useRef(chatActive)
  activeRef.current = chatActive
  // While the list is on screen it shows new messages itself: no pop-up notice.
  const listVisibleRef = useRef(true)
  listVisibleRef.current = wide || screen === 'list'
  const [showSettings, setShowSettings] = useState(false)
  // Conversation key -> its newest message, for the chat list.
  const [lastByKey, setLastByKey] = useState({})
  // Named groups you can see: id -> { id, name, created_by, members: [user ids] }
  const [groups, setGroups] = useState({})
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const groupsLoadedRef = useRef(false)
  const [groupSheet, setGroupSheet] = useState(null) // 'create' | 'add' | null
  const [dmPeers, setDmPeers] = useState([])
  const [ownerPairs, setOwnerPairs] = useState([])
  const [lightbox, setLightbox] = useState(null) // { url, name, type } for the full-screen viewer
  const [uploadProgress, setUploadProgress] = useState({}) // draft id -> 0..1
  const [aiIds, setAiIds] = useState(() => new Set()) // AI members (can be called)
  const [callWith, setCallWith] = useState(null) // { id, username } during a live call
  const [sounds, setSounds] = useState(soundsEnabled)
  // Realtime notifications (in-app toast + optional browser Notification).
  // Stored separately from sounds: the sounds toggle controls sounds only,
  // this toggle controls browser notifications only, and the in-app toast
  // still appears even when browser notifications are off.
  const [browserNotifications, setBrowserNotifications] = useState(() => {
    try {
      return localStorage.getItem('chat-notifications') === 'on'
    } catch {
      return false
    }
  })
  const [notificationPermission, setNotificationPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  // Web push (lock-screen notifications): a separate opt-in from the
  // browser Notification toggle above. The service worker is registered
  // on load so an existing subscription can be detected, but permission
  // is never requested until the user turns this on, and no key is ever
  // invented: without VITE_VAPID_PUBLIC_KEY the toggle reports that push
  // is not configured yet and stays off.
  const [pushSubscribed, setPushSubscribed] = useState(false)
  const [pushStatus, setPushStatus] = useState('unknown')
  const [pushError, setPushError] = useState('')
  const [notice, setNotice] = useState(null)
  const [unread, setUnread] = useState({})
  const browserNotificationsRef = useRef(browserNotifications)
  browserNotificationsRef.current = browserNotifications
  const noticeTimer = useRef(null)
  // Swipe-to-reply target: the message being quoted in the composer.
  // Cleared whenever the conversation changes, so a reply can only ever
  // quote a message from the conversation it is sent in.
  const [replyTo, setReplyTo] = useState(null)
  const [extraOriginals, setExtraOriginals] = useState({})
  // Read receipts (ticks): message_id -> user ids that have read it.
  // Only readers other than the sender ever get a row (the app never
  // writes a row for the sender themselves), so a sender's ticks are
  // computed from the other participants' rows only.
  const [reads, setReads] = useState({})
  // message_id -> { user_id: read_at }, for "Read 10:09" under your latest message.
  const [readTimes, setReadTimes] = useState({})
  // Messages that arrived while the app was in the background: marked as
  // read only once the screen is actually showing them.
  const pendingReadsRef = useRef([])
  // Messages already marked as read this session, so marking runs once
  // per message even if the same page is reloaded by realtime updates.
  const markedReadRef = useRef(new Set())
  const isOwnerRef = useRef(false)
  useEffect(() => {
    isOwnerRef.current = me?.username === 'mubarak'
  }, [me])
  useEffect(() => {
    setReplyTo(null)
  }, [view])

  const listRef = useRef(null)
  const shellRef = useRef(null)
  const paneRef = useRef(null)
  const edgeRef = useRef(null)
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
      for (const r of data ?? []) {
        // Guard: a reaction row for a message outside the loaded page
        // used to crash here (next[id] undefined, .push throws inside
        // the state updater, which unmounts the tree). Create the bucket
        // instead; it is harmless if that message is never rendered.
        const bucket = next[r.message_id] ?? (next[r.message_id] = [])
        bucket.push({ user_id: r.user_id, emoji: r.emoji })
      }
      return next
    })
  }, [])

  // Same shape as loadReactions, for read receipts: message_id -> the
  // user ids that have read that message. Buckets are reset for the
  // loaded page, then filled from the rows that exist; a message with
  // no rows (including every message sent before this feature) keeps an
  // empty bucket, so its ticks correctly stay grey.
  const loadReads = useCallback(async (ids) => {
    if (!ids.length) return
    const { data } = await supabase.from('message_reads').select('message_id, user_id, read_at').in('message_id', ids)
    setReadTimes((prev) => {
      const next = { ...prev }
      for (const r of data ?? []) next[r.message_id] = { ...(next[r.message_id] ?? {}), [r.user_id]: r.read_at }
      return next
    })
    setReads((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = []
      for (const r of data ?? []) {
        const bucket = next[r.message_id] ?? (next[r.message_id] = [])
        if (!bucket.includes(r.user_id)) bucket.push(r.user_id)
      }
      return next
    })
  }, [])

  const profilesRef = useRef(profiles)
  profilesRef.current = profiles

  // ---- conversations -------------------------------------------------------
  // view is { type: 'group' } (the main group chat), { type: 'group', groupId }
  // (a named group), { type: 'dm', peerId }, or
  // { type: 'owner', aId, bId } for a read-only owner view of a private
  // chat between two other members. The owner never appears as a
  // participant in an owner view.
  const isGroup = view.type === 'group'
  const peerId = view.type === 'dm' ? view.peerId : null
  const isOwnerView = view.type === 'owner'
  const groupId = isGroup ? view.groupId ?? null : null
  const typing = useTyping(myId, isGroup ? (groupId ? `g:${groupId}` : null) : peerId ?? undefined)
  const clearTyping = typing.clear
  const ownerA = isOwnerView ? view.aId : null
  const ownerB = isOwnerView ? view.bId : null
  const viewRef = useRef(view)
  viewRef.current = view

  // The owner is detected by profile username, never by a hardcoded UUID.
  const isOwner = me?.username === 'mubarak'

  const pairKey = (a, b) => [a, b].sort().join('|')

  const isMessageForView = useCallback(
    (msg, v) => {
      if (v.type === 'group') return msg.recipient_id == null && (msg.group_id ?? null) === (v.groupId ?? null)
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

  // ---- read receipts -------------------------------------------------------
  // Mark other people's messages in the currently viewed conversation as
  // read by me, once per message per session. Never in owner view: the
  // owner is not a participant there, so viewing must not create a read
  // row and must not change anyone's ticks. Own messages are never
  // marked (a sender does not read their own message into blue ticks).
  // A failed upsert (for example, before migration 0007 is applied) is
  // ignored on purpose: it must never crash the chat or block messages.
  const markAsRead = useCallback(
    (rows) => {
      const v = viewRef.current
      if (!v || v.type === 'owner' || !activeRef.current) return
      if (v.type === 'group' && v.groupId && !groupsRef.current[v.groupId]?.members.includes(myId)) return
      const todo = (rows ?? []).filter(
        (m) => m && m.user_id !== myId && isMessageForView(m, v) && !markedReadRef.current.has(m.id),
      )
      if (!todo.length) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        pendingReadsRef.current.push(...todo)
        return
      }
      for (const m of todo) markedReadRef.current.add(m.id)
      // ignoreDuplicates: insert-or-skip. A plain upsert tries to UPDATE an
      // existing row, which the read policies don't allow (it failed with 403).
      supabase
        .from('message_reads')
        .upsert(
          todo.map((m) => ({ message_id: m.id, user_id: myId })),
          { onConflict: 'message_id,user_id', ignoreDuplicates: true },
        )
        .then(() => {})
        .catch(() => {})
    },
    [myId, isMessageForView],
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

  // ---- realtime notifications --------------------------------------------
  // Unread keys: 'group', 'dm:<peerId>', 'owner:<a>|<b>'. The key, not the
  // message, is what the panel badge and the document title count, so a
  // message in the currently viewed conversation never creates a count.
  const viewKey = (v) => {
    if (v.type === 'group') return v.groupId ? `group:${v.groupId}` : 'group'
    if (v.type === 'owner') return `owner:${[v.aId, v.bId].sort().join('|')}`
    return `dm:${v.peerId}`
  }

  const clearUnread = useCallback((key) => {
    setUnread((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  // Target view and label for a message that is NOT in the current view.
  // Group: everyone. DM: only the two participants, enforced by RLS, so
  // this branch is only reached for the viewer's own DMs. Other-member DM:
  // only the owner, labelled as an owner view, never as a participant DM.
  const notifyTarget = useCallback(
    (m) => {
      if (m.group_id) {
        return { key: `group:${m.group_id}`, view: { type: 'group', groupId: m.group_id }, label: groupsRef.current[m.group_id]?.name ?? 'Group', owner: false }
      }
      if (m.recipient_id == null) return { key: 'group', view: { type: 'group' }, label: 'Group Chat', owner: false }
      if (m.user_id !== myId && m.recipient_id !== myId) {
        const [a, b] = [m.user_id, m.recipient_id].sort()
        return { key: `owner:${a}|${b}`, view: { type: 'owner', aId: a, bId: b }, label: null, owner: true }
      }
      const peer = m.user_id === myId ? m.recipient_id : m.user_id
      return { key: `dm:${peer}`, view: { type: 'dm', peerId: peer }, label: null, owner: false }
    },
    [myId],
  )

  // ---- chat list ---------------------------------------------------------
  const lastRef = useRef(lastByKey)
  lastRef.current = lastByKey
  const bumpLast = useCallback(
    (m) => {
      const { key } = notifyTarget(m)
      setLastByKey((prev) => {
        const cur = prev[key]
        if (cur && (cur.id === m.id || Date.parse(cur.created_at) > Date.parse(m.created_at))) return prev
        return { ...prev, [key]: m }
      })
    },
    [notifyTarget],
  )

  // Newest message of every conversation, plus unread counts that survive a
  // reload: anything from others newer than the last message you sent or
  // read in that conversation.
  const loadInbox = useCallback(async () => {
    if (!myId) return
    const [{ data: groupRows }, { data: dmRows }, { data: readRows }] = await Promise.all([
      supabase.from('messages').select(PREVIEW_FIELDS).is('recipient_id', null).order('id', { ascending: false }).limit(300),
      supabase.from('messages').select(PREVIEW_FIELDS).not('recipient_id', 'is', null).order('id', { ascending: false }).limit(600),
      supabase.from('message_reads').select('message_id').eq('user_id', myId).order('message_id', { ascending: false }).limit(800),
    ])
    const readIds = new Set((readRows ?? []).map((r) => r.message_id))
    const byKey = {}
    for (const m of [...(groupRows ?? []), ...(dmRows ?? [])]) {
      const { key, owner } = notifyTarget(m)
      ;(byKey[key] ??= { owner, rows: [] }).rows.push(m)
      if (owner) addOwnerPair(m.user_id, m.recipient_id)
      else if (m.recipient_id) addDmPeer(m.user_id === myId ? m.recipient_id : m.user_id)
    }
    const last = {}
    const counts = {}
    for (const [key, { owner, rows }] of Object.entries(byKey)) {
      rows.sort((a, b) => b.id - a.id)
      last[key] = rows[0]
      if (owner) continue
      const seen = rows.find((m) => m.user_id === myId || readIds.has(m.id))
      counts[key] = rows.filter((m) => m.user_id !== myId && (!seen || m.id > seen.id)).length
    }
    setLastByKey((prev) => {
      const next = { ...last }
      for (const [key, m] of Object.entries(prev)) if (!next[key] || m.id > next[key].id) next[key] = m
      return next
    })
    setUnread((prev) => {
      const next = { ...prev }
      const open = activeRef.current ? viewKey(viewRef.current) : null
      for (const [key, n] of Object.entries(counts)) {
        if (key === open) continue
        if (n > (next[key] ?? 0)) next[key] = n
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId, notifyTarget, addDmPeer, addOwnerPair])

  useEffect(() => {
    loadInbox()
  }, [loadInbox])

  const loadGroups = useCallback(async () => {
    const [{ data: rows, error: gErr }, { data: members }] = await Promise.all([
      supabase.from('chat_groups').select('id, name, created_by, created_at').order('created_at'),
      supabase.from('chat_group_members').select('group_id, user_id, added_at').order('added_at'),
    ])
    if (gErr) return // before migration 0014: no named groups yet
    const next = {}
    for (const g of rows ?? []) next[g.id] = { ...g, members: [] }
    for (const m of members ?? []) next[m.group_id]?.members.push(m.user_id)
    groupsLoadedRef.current = true
    setGroups(next)
  }, [])
  useEffect(() => {
    if (myId) loadGroups()
  }, [myId, loadGroups])

  // ---- named groups (the owner makes and manages them) ----
  async function createGroup({ name, ids }) {
    const { data: g, error: err } = await supabase.from('chat_groups').insert({ name }).select().single()
    if (err) return setError(err.message)
    const { error: mErr } = await supabase
      .from('chat_group_members')
      .insert([...new Set([myId, ...ids])].map((user_id) => ({ group_id: g.id, user_id })))
    if (mErr) setError(mErr.message)
    await loadGroups()
    setGroupSheet(null)
    openConversation({ type: 'group', groupId: g.id })
  }
  async function addToGroup({ ids }) {
    const { error: err } = await supabase
      .from('chat_group_members')
      .insert(ids.map((user_id) => ({ group_id: view.groupId, user_id })))
    if (err) setError(err.message)
    await loadGroups()
    setGroupSheet(null)
  }
  async function removeFromGroup(userId) {
    const g = groups[view.groupId]
    if (!g || !window.confirm(`Remove ${profiles[userId]} from ${g.name}?`)) return
    const { error: err } = await supabase.from('chat_group_members').delete().match({ group_id: g.id, user_id: userId })
    if (err) setError(err.message)
    loadGroups()
  }
  async function leaveGroup() {
    const g = groups[view.groupId]
    if (!g || !window.confirm(`Leave ${g.name}? You won't see its messages anymore.`)) return
    const { error: err } = await supabase.from('chat_group_members').delete().match({ group_id: g.id, user_id: myId })
    if (err) return setError(err.message)
    setShowMembers(false)
    await loadGroups()
  }
  async function renameGroup() {
    const g = groups[view.groupId]
    const name = window.prompt('Group name', g?.name ?? '')?.trim()
    if (!g || !name || name === g.name) return
    const { error: err } = await supabase.from('chat_groups').update({ name: name.slice(0, 60) }).eq('id', g.id)
    if (err) setError(err.message)
    loadGroups()
  }
  async function deleteGroup() {
    const g = groups[view.groupId]
    if (!g || !window.confirm(`Delete ${g.name} and all its messages for everyone? This can't be undone.`)) return
    const { error: err } = await supabase.from('chat_groups').delete().eq('id', g.id)
    if (err) return setError(err.message)
    setShowMembers(false)
    goBack()
    setView({ type: 'group' })
    await loadGroups()
    loadInbox()
  }

  // Removed from (or deleted) the group you're looking at: go back to the list.
  useEffect(() => {
    if (!groupsLoadedRef.current || view.type !== 'group' || !view.groupId) return
    if (!groups[view.groupId]) {
      setView({ type: 'group' })
      setScreen('list')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups])

  const previewOf = (m) => {
    if (m.call_duration != null) return '📞 Voice call'
    if (m.content?.trim()) {
      const text = m.content.trim()
      return text.length > 80 ? `${text.slice(0, 80)}…` : text
    }
    if (m.attachment_path) {
      if (m.attachment_type?.startsWith('image/')) return 'sent a photo'
      if (m.attachment_type?.startsWith('video/')) return 'sent a video'
      if (m.attachment_type?.startsWith('audio/')) return 'sent a voice note'
      return 'sent a file'
    }
    return 'sent a message'
  }

  // The one way to open a conversation: from the list, a notification, a
  // member's "Message" button, or a notification tap. Reopening the chat that
  // is already loaded is instant (no reload). On phones the chat slides in and
  // gets a history entry, so the back gesture / back button returns to the list.
  const openConversation = useCallback(
    (v) => {
      const same = viewKey(v) === viewKey(viewRef.current)
      if (!same) setView(v)
      setNotice(null)
      setShowMembers(false)
      setShowSettings(false)
      if (!window.matchMedia?.(WIDE_QUERY).matches && history.state?.chatOpen !== true) {
        history.pushState({ chatOpen: true }, '')
      }
      setScreen('chat')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const openTarget = useCallback((target) => openConversation(target.view), [openConversation])

  const goBack = useCallback(() => {
    setScreen('list')
    if (history.state?.chatOpen) history.back()
  }, [])

  useEffect(() => {
    const onPop = () => {
      if (!history.state?.chatOpen) setScreen('list')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // A chat opened straight from a notification link still goes back to the list.
  useEffect(() => {
    if (screen === 'chat' && !wide && !history.state?.chatOpen) {
      history.replaceState({}, '')
      history.pushState({ chatOpen: true }, '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The single place a realtime arrival becomes a notification. Own
  // messages and messages in the currently viewed conversation never reach
  // here from the realtime handler, so they get no toast and no count.
  // The toast replaces any previous toast (latest wins, never a stack).
  const notify = useCallback(
    (m) => {
      const target = notifyTarget(m)
      const preview = previewOf(m)
      setUnread((prev) => ({ ...prev, [target.key]: (prev[target.key] ?? 0) + 1 }))
      if (!listVisibleRef.current) {
        setNotice({ key: target.key, view: target.view, senderId: m.user_id, preview, owner: target.owner })
      }
      if (browserNotificationsRef.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const sender = profilesRef.current[m.user_id] ?? 'Someone'
        const convo = target.owner ? 'Owner view' : target.label ?? profilesRef.current[target.view.peerId] ?? 'Private chat'
        try {
          const n = new Notification(`${sender} · ${convo}`, { body: preview, tag: target.key })
          n.onclick = () => {
            window.focus()
            openTarget(target)
            n.close()
          }
        } catch {
          // Notification construction can throw if permission was revoked
          // between the check and construction; the in-app toast above
          // already shows, so just skip the browser notification.
        }
      }
    },
    [notifyTarget, openTarget],
  )

  // Short preview used for a reply quote, in the composer and on a sent
  // reply. Text is truncated; attachments get a type word, never a URL.
  const quotePreviewOf = (m) => {
    if (!m) return 'Original message not loaded'
    if (m.call_duration != null) return 'voice call'
    if (m.content?.trim()) {
      const text = m.content.trim()
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    }
    if (m.attachment_path) {
      if (m.attachment_type?.startsWith('image/')) return 'photo'
      if (m.attachment_type?.startsWith('video/')) return 'video'
      if (m.attachment_type?.startsWith('audio/')) return 'voice note'
      return 'file'
    }
    return 'message'
  }

  // Originals for replies whose quoted message is not in the currently
  // loaded page (older than the page, or a reply that arrived by realtime
  // before its original was loaded). Fetched one at a time through the
  // normal RLS read path, so a viewer only ever sees originals they can
  // already read in this conversation.
  useEffect(() => {
    const known = new Set(messages.map((m) => m.id))
    const missing = [...new Set(messages.filter((m) => m.reply_to_id && !known.has(m.reply_to_id)).map((m) => m.reply_to_id))]
      .filter((id) => !extraOriginals[id])
    if (!missing.length) return
    let cancelled = false
    supabase
      .from('messages')
      .select('*')
      .in('id', missing)
      .then(({ data }) => {
        if (cancelled) return
        setExtraOriginals((prev) => {
          const next = { ...prev }
          for (const row of data ?? []) next[row.id] = row
          return next
        })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  // A conversation's unread count clears when it is opened, and the current
  // conversation's count clears again when the tab regains focus.
  // Coming onto the screen (opened, or slid back in) marks what's shown as read.
  useEffect(() => {
    if (!chatActive) return
    clearUnread(viewKey(view))
    markAsRead(messagesRef.current)
    refreshReactions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, chatActive])

  useEffect(() => {
    const onFocus = () => {
      if (!document.hidden && activeRef.current) clearUnread(viewKey(viewRef.current))
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Document title carries the total unread count, so a hidden tab still
  // shows at a glance that something arrived.
  const totalUnread = Object.values(unread).reduce((sum, n) => sum + n, 0)
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Group Chat` : 'Group Chat'
    return () => {
      document.title = 'Group Chat'
    }
  }, [totalUnread])

  // The toast auto-dismisses after a few seconds; a close button dismisses
  // it immediately (see render). Restart the timer on every new notice.
  useEffect(() => {
    if (!notice) return
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(noticeTimer.current)
  }, [notice])

  async function toggleBrowserNotifications(on) {
    if (!on) {
      setBrowserNotifications(false)
      try {
        localStorage.setItem('chat-notifications', 'off')
      } catch {
        // storage unavailable; the toggle just won't persist
      }
      return
    }
    // Permission is requested only when the user turns this on, never on
    // page load, and never again after a denial: a denied toggle simply
    // stays off and the in-app toast keeps working.
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported')
      setError('Browser notifications are not supported here. The in-app notice still works.')
      return
    }
    let permission = Notification.permission
    if (permission === 'default') permission = await Notification.requestPermission()
    setNotificationPermission(permission)
    if (permission !== 'granted') return
    setBrowserNotifications(true)
    try {
      localStorage.setItem('chat-notifications', 'on')
    } catch {
      // storage unavailable; the toggle just won't persist
    }
  }

  // ---- web push ----------------------------------------------------------
  // VAPID public keys are base64url; the Push API needs the raw bytes.
  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4)
    const raw = window.atob(base64.replace(/-/g, '+').replace(/_/g, '/') + padding)
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
  }

  // FIX (blank-page crash): this used to be a plain function that returned
  // null when service workers or PushManager were unavailable, but the
  // mount effect below calls getPushRegistration().then(...). Calling
  // .then on null throws a synchronous TypeError inside the effect, and
  // with no error boundary React unmounts the whole tree, leaving the
  // white blank page seen live. iOS Safari tabs (and any browser without
  // PushManager) hit exactly this path. Making it async means it always
  // returns a promise, resolving to null when push is unavailable, so the
  // chain below is safe and push simply stays off.
  async function getPushRegistration() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
    return navigator.serviceWorker.register('/sw.js')
  }

  // Detect an existing subscription on load, without asking for anything:
  // permission is only requested from the toggle below.
  useEffect(() => {
    let cancelled = false
    getPushRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => {
        if (cancelled) return
        if (sub) {
          setPushSubscribed(true)
          setPushStatus('on')
        } else {
          setPushStatus('off')
        }
      })
      .catch(() => {
        if (!cancelled) setPushStatus('unsupported')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A notification tap on an already-open app focuses it and tells it to
  // open the conversation, instead of opening a second tab.
  useEffect(() => {
    const onServiceWorkerMessage = (e) => {
      const v = e.data?.view
      if (e.data?.type !== 'open-conversation' || !v) return
      if (v.type === 'group') openConversation(v.groupId ? { type: 'group', groupId: v.groupId } : { type: 'group' })
      else if (v.type === 'dm' && v.peerId) openConversation({ type: 'dm', peerId: v.peerId })
      else if (v.type === 'owner' && v.aId && v.bId && isOwnerRef.current) {
        openConversation({ type: 'owner', aId: v.aId, bId: v.bId })
      }
    }
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
  }, [])

  async function togglePush(on) {
    setPushError('')
    if (!on) {
      try {
        const reg = await getPushRegistration()
        const sub = await reg?.pushManager.getSubscription()
        if (sub) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
          await sub.unsubscribe()
        }
      } catch (err) {
        setPushError(err.message)
      }
      setPushSubscribed(false)
      setPushStatus('off')
      return
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      setPushStatus('unsupported')
      setPushError('This browser does not support web push. The in-app notice still works.')
      return
    }
    let permission = Notification.permission
    if (permission === 'default') permission = await Notification.requestPermission()
    setNotificationPermission(permission)
    if (permission !== 'granted') {
      setPushStatus('denied')
      return
    }
    // The public VAPID key comes from the server, which creates the key pair
    // the first time anyone turns push on (api/push/key.js). A key set at
    // build time in VITE_VAPID_PUBLIC_KEY still takes precedence.
    let vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
    if (!vapidKey) {
      try {
        const res = await fetch('/api/push/key')
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
        vapidKey = body.publicKey
      } catch (err) {
        setPushStatus('unconfigured')
        setPushError(`Push isn't available on this server yet: ${err.message}`)
        return
      }
    }
    try {
      const reg = await getPushRegistration()
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })
      const json = sub.toJSON()
      const { error: dbErr } = await supabase.from('push_subscriptions').upsert(
        { user_id: myId, endpoint: sub.endpoint, keys: json.keys },
        { onConflict: 'endpoint' },
      )
      if (dbErr) {
        await sub.unsubscribe()
        throw dbErr
      }
      setPushSubscribed(true)
      setPushStatus('on')
    } catch (err) {
      setPushStatus('error')
      setPushError(err.message)
    }
  }

  function filterConversation(query, v) {
    if (v.type === 'group') {
      return v.groupId ? query.eq('group_id', v.groupId) : query.is('recipient_id', null).is('group_id', null)
    }
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
    openConversation({ type: 'dm', peerId: id })
  }

  const ensureProfile = useCallback(async (userId) => {
    if (profilesRef.current[userId]) return
    const { data } = await supabase.from('profiles').select('id, username, avatar_path, is_ai, last_seen_at').eq('id', userId).single()
    if (data) applyProfile(data)
  }, [])

  const applyProfile = (row) => {
    setProfiles((p) => ({ ...p, [row.id]: row.username }))
    setAvatars((a) => ({ ...a, [row.id]: avatarUrl(row.avatar_path) }))
    if (row.last_seen_at) setLastSeen((l) => ({ ...l, [row.id]: Date.parse(row.last_seen_at) }))
    if (row.is_ai != null) {
      setAiIds((prev) => {
        if (prev.has(row.id) === row.is_ai) return prev
        const next = new Set(prev)
        if (row.is_ai) next.add(row.id)
        else next.delete(row.id)
        return next
      })
    }
  }

  const addMessage = useCallback(
    (msg) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev
        // Your own message arriving over realtime before its save finished:
        // it replaces the "sending" bubble in place instead of doubling it.
        const pending = prev.findIndex(
          (m) =>
            m._status &&
            m.user_id === msg.user_id &&
            (msg.attachment_path
              ? m.attachment_path === msg.attachment_path
              : !m._file && (m.content ?? null) === (msg.content ?? null)) &&
            (m.recipient_id ?? null) === (msg.recipient_id ?? null) &&
            (m.group_id ?? null) === (msg.group_id ?? null),
        )
        if (pending === -1) return [...prev, msg]
        const next = prev.slice()
        next[pending] = msg
        return next
      })
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
        supabase.from('profiles').select('id, username, avatar_path, is_ai, last_seen_at'),
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
      setAiIds(new Set((profileRows ?? []).filter((p) => p.is_ai).map((p) => p.id)))
      setLastSeen(
        Object.fromEntries((profileRows ?? []).filter((p) => p.last_seen_at).map((p) => [p.id, Date.parse(p.last_seen_at)])),
      )
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

  // Escape closes an open sheet, or goes back to the list on a phone.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.lightbox, .media-viewer, .call-screen')) return
      if (showMembers) setShowMembers(false)
      else if (showSettings) setShowSettings(false)
      else if (!wide && screen === 'chat' && !document.activeElement?.closest?.('.composer')) goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showMembers, showSettings, wide, screen, goBack])

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
      loadReads(rows.map((m) => m.id))
      markAsRead(rows)
      signUrls(rows.map((m) => m.attachment_path))
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, view])

  // ---- never miss a message --------------------------------------------------
  // Phones cut the realtime connection whenever the app is in the background
  // or the network blips, and messages sent meanwhile are not replayed. So:
  // after every (re)connect, whenever the app comes back to the screen or
  // back online, and every few seconds while it is open, fetch everything
  // newer than the last message seen and run it through the live handler.
  const seenIdsRef = useRef(new Set())
  const lastIdRef = useRef(null)
  const incomingRef = useRef(null)
  const catchingUpRef = useRef(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  useEffect(() => {
    if (!myId) return
    supabase
      .from('messages')
      .select('id')
      .order('id', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (lastIdRef.current == null) lastIdRef.current = data?.[0]?.id ?? 0
      })
  }, [myId])

  const catchUp = useCallback(async () => {
    if (catchingUpRef.current || lastIdRef.current == null) return
    catchingUpRef.current = true
    try {
      for (let page = 0; page < 5; page++) {
        const { data, error: err } = await supabase
          .from('messages')
          .select('*')
          .gt('id', lastIdRef.current)
          .order('id')
          .limit(100)
        if (err || !data?.length) break
        for (const m of data) incomingRef.current?.(m)
        if (data.length < 100) break
      }
    } finally {
      catchingUpRef.current = false
    }
  }, [])

  // Read receipts can be missed the same way; refresh them for your own
  // messages in view.
  const refreshReads = useCallback(() => {
    const own = messagesRef.current.filter((m) => m.user_id === myId).map((m) => m.id)
    if (own.length) loadReads(own.slice(-50))
  }, [myId, loadReads])

  // Reactions (tapbacks) can be missed the same way, e.g. an AI reacting
  // while the phone was in the background: re-read them for what's on screen.
  const refreshReactions = useCallback(() => {
    const ids = messagesRef.current.filter((m) => typeof m.id === 'number').slice(-60).map((m) => m.id)
    if (ids.length) loadReactions(ids)
  }, [loadReactions])

  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState !== 'visible') return
      catchUp()
      refreshReads()
      refreshReactions()
      const pending = pendingReadsRef.current
      pendingReadsRef.current = []
      if (pending.length) markAsRead(pending)
    }
    document.addEventListener('visibilitychange', onBack)
    window.addEventListener('focus', onBack)
    window.addEventListener('online', onBack)
    let tick = 0
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      catchUp()
      if (++tick % 3 === 0) {
        refreshReactions()
        refreshReads()
      }
    }, 4000)
    return () => {
      document.removeEventListener('visibilitychange', onBack)
      window.removeEventListener('focus', onBack)
      window.removeEventListener('online', onBack)
      clearInterval(timer)
    }
  }, [catchUp, refreshReads, refreshReactions, markAsRead])

  useEffect(() => {
    // One handler for every new message, whether it came live over the
    // realtime channel or from catchUp() after the connection dropped.
    const onInsert = (m) => {
        if (seenIdsRef.current.has(m.id)) return
        seenIdsRef.current.add(m.id)
        if (lastIdRef.current == null || m.id > lastIdRef.current) lastIdRef.current = m.id
        clearTyping(m.user_id)
        bumpLast(m)
        const peer = dmPeerOf(m)
        if (peer) {
          // A DM for a peer not currently being viewed still adds that peer
          // to the side panel list, without leaking the message into the
          // current view. If it is from someone else, it also becomes a
          // realtime notification (toast, unread count, optional browser
          // notification) for that DM. Own messages never notify.
          addDmPeer(peer)
          ensureProfile(m.user_id)
          if (!isMessageForView(m, viewRef.current)) {
            if (m.user_id !== myId) {
              playReceive()
              notify(m)
            }
            return
          }
        } else if (m.recipient_id != null) {
          // A DM between two other members: it belongs in the owner's
          // list only, never in the group view or a participant's DM view,
          // and it never names the owner as a participant. The owner, and
          // only the owner, gets a notification labelled as an owner view.
          if (viewRef.current.type === 'owner' && isMessageForView(m, viewRef.current)) {
            playReceive()
            addMessage(m)
            if (!activeRef.current) notify(m)
            return
          }
          addOwnerPair(m.user_id, m.recipient_id)
          ensureProfile(m.user_id)
          if (isOwnerRef.current && m.user_id !== myId) {
            playReceive()
            notify(m)
          }
          return
        } else if (!isMessageForView(m, viewRef.current)) {
          // A group message arriving while another conversation is viewed:
          // it is not added to the current view, but it does notify (named
          // groups: only their members; the owner can see others silently).
          if (m.group_id && !groupsRef.current[m.group_id]) loadGroups()
          if (m.group_id && groupsRef.current[m.group_id] && !groupsRef.current[m.group_id].members.includes(myId)) return
          if (m.user_id !== myId) {
            playReceive()
            notify(m)
          }
          return
        }
        addMessage(m)
        if (m.user_id !== myId) {
          playReceive()
          // Loaded in the background (phone showing the list): it's unread.
          if (activeRef.current) markAsRead([m])
          else notify(m)
        }
    }
    incomingRef.current = onInsert

    const channel = supabase
      .channel('group-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => onInsert(m))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, ({ old }) => {
        setMessages((prev) => prev.filter((m) => m.id !== old.id))
        if (Object.values(lastRef.current).some((m) => m.id === old.id)) loadInbox()
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reads' }, ({ new: r }) => {
        setReadTimes((prev) => ({ ...prev, [r.message_id]: { ...(prev[r.message_id] ?? {}), [r.user_id]: r.read_at } }))
        setReads((prev) => {
          const list = prev[r.message_id] ?? []
          if (list.includes(r.user_id)) return prev
          return { ...prev, [r.message_id]: [...list, r.user_id] }
        })
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, ({ new: r }) =>
        applyReaction(r.message_id, r.user_id, r.emoji, true),
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, ({ old: r }) =>
        applyReaction(r.message_id, r.user_id, r.emoji, false),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_groups' }, () => loadGroups())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_group_members' }, () => {
        loadGroups()
        loadInbox()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, ({ new: row }) => {
        if (row?.id) applyProfile(row)
      })
      .on('presence', { event: 'sync' }, () => {
        const ids = new Set(
          Object.values(channel.presenceState())
            .flat()
            .map((p) => p?.user_id)
            .filter(Boolean),
        )
        setOnline([...ids])
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.track({ user_id: myId })
          // (Re)connected: fetch anything sent while the connection was down.
          catchUp()
          refreshReads()
        }
      })

    return () => {
      incomingRef.current = null
      supabase.removeChannel(channel)
    }
  }, [myId, catchUp, refreshReads, addMessage, applyReaction, dmPeerOf, addDmPeer, addOwnerPair, ensureProfile, isMessageForView, notify, markAsRead, bumpLast, loadInbox, loadGroups])

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
    loadReads(rows.map((m) => m.id))
    markAsRead(rows)
    signUrls(rows.map((m) => m.attachment_path))
  }

  // ---- scrolling -----------------------------------------------------------

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [])

  // A typing bubble appearing at the bottom keeps the view pinned there.
  const typingCount = typing.typers.length
  useLayoutEffect(() => {
    if (typingCount) scrollToBottom()
  }, [typingCount, scrollToBottom])

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

  async function send({ text, file, duration }) {
    // Owner view is read-only; the composer is hidden there, and this is
    // the second line of defence if send is ever called from that view.
    if (viewRef.current.type === 'owner') return false
    setError('')
    // A reply only quotes a message from the conversation being sent in.
    // replyTo is cleared on every view change, so this check is a second
    // line: if the quoted message is no longer in this view, send plain.
    const replyToId =
      replyTo && messages.some((m) => m.id === replyTo.id && !m._status) ? replyTo.id : null

    // Text: show it straight away, save in the background (deliver below).
    if (!file) {
      const draft = {
        id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        user_id: myId,
        recipient_id: peerId,
        group_id: groupId,
        reply_to_id: replyToId,
        content: text || null,
        created_at: new Date().toISOString(),
        _status: 'sending',
      }
      stickToBottom.current = true
      setMessages((prev) => [...prev, draft])
      bumpLast(draft)
      setReplyTo(null)
      playSend()
      deliver(draft)
      return true
    }

    // Photo, video, voice note or file: show it at once from the local copy,
    // then shrink (photos), upload with progress and save in the background.
    if (file.size > MAX_FILE_BYTES) {
      setError('Files must be 25 MB or smaller.')
      return false
    }
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const draft = {
      id: tempId,
      user_id: myId,
      recipient_id: peerId,
      group_id: groupId,
      reply_to_id: replyToId,
      content: text || null,
      created_at: new Date().toISOString(),
      attachment_path: `pending/${tempId}`,
      attachment_name: file.name,
      attachment_type: file.type || 'application/octet-stream',
      attachment_size: file.size,
      attachment_duration: file.type?.startsWith('audio/') && duration ? duration : null,
      _status: 'sending',
      _file: file,
      _localUrl: URL.createObjectURL(file),
    }
    stickToBottom.current = true
    setMessages((prev) => [...prev, draft])
    bumpLast(draft)
    setReplyTo(null)
    playSend()
    deliver(draft)
    return true
  }

  // Saves an optimistic text message. On success the temporary bubble becomes
  // the real message (or is dropped if realtime already delivered it); on
  // failure it stays, marked "Not delivered", with Tap to retry.
  async function deliver(draft) {
    let attachment = {}
    if (draft._file) {
      // Upload once; a retry after a failed save reuses the uploaded file.
      let { _uploadedPath: path, _upload: up } = draft
      if (!path) {
        try {
          const prepared = await prepareForUpload(draft._file)
          const safeName = prepared.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file'
          path = `${myId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
          await uploadWithProgress(path, prepared, (p) =>
            setUploadProgress((prev) => ({ ...prev, [draft.id]: p })),
          )
          up = { name: prepared.name, type: prepared.type || draft.attachment_type, size: prepared.size }
        } catch (err) {
          setError(err.message)
          setMessages((prev) => prev.map((m) => (m.id === draft.id ? { ...m, _status: 'failed' } : m)))
          return
        }
        // Keep showing the local copy (no flash while the real link loads).
        setUrls((prev) => ({ ...prev, [path]: draft._localUrl }))
        setMessages((prev) =>
          prev.map((m) => (m.id === draft.id ? { ...m, attachment_path: path, _uploadedPath: path, _upload: up } : m)),
        )
      }
      attachment = {
        attachment_path: path,
        attachment_name: up.name,
        attachment_type: up.type,
        attachment_size: up.size,
        ...(draft.attachment_duration ? { attachment_duration: draft.attachment_duration } : {}),
      }
    }
    const { data, error: insErr } = await supabase
      .from('messages')
      .insert({
        content: draft.content,
        recipient_id: draft.recipient_id,
        group_id: draft.group_id ?? null,
        reply_to_id: draft.reply_to_id,
        ...attachment,
      })
      .select()
      .single()
    setUploadProgress((prev) => {
      if (!(draft.id in prev)) return prev
      const next = { ...prev }
      delete next[draft.id]
      return next
    })
    setMessages((prev) => {
      if (insErr || !data) return prev.map((m) => (m.id === draft.id ? { ...m, _status: 'failed' } : m))
      return prev.some((m) => m.id === data.id)
        ? prev.filter((m) => m.id !== draft.id)
        : prev.map((m) => (m.id === draft.id ? data : m))
    })
    if (data) setReactions((prev) => (prev[data.id] ? prev : { ...prev, [data.id]: [] }))
  }

  function retrySend(msg) {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _status: 'sending' } : m)))
    deliver({ ...msg, _status: 'sending' })
  }

  // A finished call becomes a call card in the private chat; its text is the
  // transcript, so the AI's text agent also knows what was said.
  async function saveCall(peer, { duration, transcript }) {
    setCallWith(null)
    if (!peer || duration < 2) return
    const { data, error: err } = await supabase
      .from('messages')
      .insert({
        recipient_id: peer.id,
        content: (transcript || '(no speech was recorded)').slice(0, 40000),
        call_duration: duration,
      })
      .select()
      .single()
    if (err) return setError(`Couldn't save the call: ${err.message}`)
    stickToBottom.current = true
    addMessage(data)
  }

  // Start a reply from a swipe or from the Reply action. Never in an
  // owner view, where the composer is hidden and read-only.
  function startReply(msg) {
    if (isOwnerView) return
    setReplyTo(msg)
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

  // Originals for reply quotes: loaded messages first, then any older
  // original fetched on demand. A missing original renders a fallback
  // quote, never a broken link or a guess at its text.
  // This hook MUST stay above the early returns below: it was previously
  // below them, so the first render (me undefined, Splash) ran fewer hooks
  // than the next render (me loaded), which React rejects with error #310
  // "Rendered more hooks than during the previous render" and unmounts
  // the whole chat. Hooks never run conditionally, in any order.
  const originals = useMemo(() => {
    const map = new Map(messages.map((m) => [m.id, m]))
    for (const [id, row] of Object.entries(extraOriginals)) if (!map.has(Number(id))) map.set(Number(id), row)
    return map
  }, [messages, extraOriginals])

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

  // iMessage-style status under your latest message: "Delivered", or
  // "Read 10:09" in a private chat / "Read by …" in the group.
  // (Plain code, not a hook: this runs after the early returns above.)
  let lastOwnId = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].user_id === myId) {
      lastOwnId = messages[i].id
      break
    }
  }

  function readStatus(msg) {
    if (msg._status === 'sending') {
      const p = uploadProgress[msg.id]
      return { label: p != null && p < 1 ? `Sending… ${Math.round(p * 100)}%` : 'Sending…' }
    }
    if (msg._status === 'failed') return { label: 'Not delivered', failed: true }
    const readers = (reads[msg.id] ?? []).filter((id) => id !== myId)
    const times = readTimes[msg.id] ?? {}
    const latest = readers
      .map((id) => times[id])
      .filter(Boolean)
      .sort()
      .at(-1)
    const time = latest ? formatReadTime(latest) : ''
    if (view.type === 'group') {
      if (!readers.length) return { label: 'Delivered' }
      const others = otherMemberIds
      if (others.length && others.every((id) => readers.includes(id))) return { label: 'Read by everyone', time, read: true }
      return { label: `Read by ${readers.map((id) => profiles[id] ?? 'someone').join(', ')}`, time, read: true }
    }
    return readers.includes(view.peerId) ? { label: 'Read', time, read: true } : { label: 'Delivered' }
  }

  const memberIds = Object.keys(profiles)
  const currentGroup = groupId ? groups[groupId] ?? null : null
  // People in the conversation on screen: the named group's members, or everyone.
  const groupMemberIds = currentGroup ? currentGroup.members.filter((id) => profiles[id]) : memberIds
  // The owner can look into a named group they're not in, read only.
  const notInGroup = Boolean(groupId && currentGroup && !currentGroup.members.includes(myId))
  const readOnly = isOwnerView || notInGroup
  const groupTitle = groupId ? currentGroup?.name ?? 'Group' : 'Group Chat'
  const groupFaces = (g) => {
    const others = g.members.filter((id) => id !== myId && profiles[id])
    return (others.length >= 2 ? others.slice(0, 2) : [...others, myId].slice(0, 2)).map((id) => ({
      id,
      name: profiles[id],
      src: avatars[id],
    }))
  }
  // (Plain code after the early returns, not a hook.)
  const ONLINE_WINDOW_MS = 2 * 60 * 1000
  const online = [
    ...new Set([
      ...presenceIds,
      ...Object.entries(lastSeen)
        .filter(([, t]) => clock - t < ONLINE_WINDOW_MS)
        .map(([id]) => id),
    ]),
  ]
  const typingNames = typing.typers.map((id) => profiles[id]).filter(Boolean)
  const headerTyping = typingNames.length > 0
  const headerSubtitle = headerTyping
    ? isGroup
      ? `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…`
      : 'typing…'
    : isGroup
      ? `${groupMemberIds.length} people${
          groupMemberIds.filter((id) => online.includes(id)).length
            ? ` · ${groupMemberIds.filter((id) => online.includes(id)).length} online`
            : ''
        }${notInGroup ? ' · read only' : ''}`
      : isOwnerView
        ? 'Owner view · read only'
        : online.includes(peerId)
          ? 'Online'
          : 'Private chat'

  // Everyone else in the group, used only for the read-receipt rule:
  // a group message is blue only once every one of these has read it.
  const otherMemberIds = groupMemberIds.filter((id) => id !== myId)
  const peerName = peerId ? profiles[peerId] ?? '…' : null
  const ownerNameA = ownerA ? profiles[ownerA] ?? '…' : null
  const ownerNameB = ownerB ? profiles[ownerB] ?? '…' : null
  const ownerPairLabel = isOwnerView ? `${ownerNameA} and ${ownerNameB}` : null
  const ownerPairList = ownerPairs
    .filter(([a, b]) => profiles[a] && profiles[b])
    .sort((p, q) => `${profiles[p[0]]} and ${profiles[p[1]]}`.localeCompare(`${profiles[q[0]]} and ${profiles[q[1]]}`))

  const noticeSender = notice ? profiles[notice.senderId] ?? 'Someone' : null
  const noticeLabel = notice
    ? notice.owner
      ? `Owner view · ${profiles[notice.view.aId] ?? '…'} and ${profiles[notice.view.bId] ?? '…'}`
      : notice.view.type === 'group'
        ? notice.view.groupId
          ? groups[notice.view.groupId]?.name ?? 'Group'
          : 'Group Chat'
        : 'Private message'
    : null

  // Swipe from the left edge to go back to the list, following the finger
  // like iOS. (Plain code, not hooks: this runs after the early returns.)
  const setDrag = (dx) => {
    const list = shellRef.current?.querySelector('.pane-list-wrap')
    if (paneRef.current) paneRef.current.style.transform = dx == null ? '' : `translateX(${dx}px)`
    if (list) list.style.transform = dx == null ? '' : `translateX(${-28 + (dx / window.innerWidth) * 28}%)`
    shellRef.current?.classList.toggle('dragging', dx != null)
  }
  const edgeSwipe = wide
    ? {}
    : {
        onTouchStart(e) {
          const t = e.touches[0]
          edgeRef.current = screen === 'chat' && e.touches.length === 1 && t.clientX < 28
            ? { x: t.clientX, y: t.clientY, dx: 0, at: Date.now(), on: false }
            : null
        },
        onTouchMove(e) {
          const g = edgeRef.current
          if (!g) return
          const t = e.touches[0]
          const dx = t.clientX - g.x
          const dy = t.clientY - g.y
          if (!g.on) {
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return (edgeRef.current = null)
            if (dx < 10) return
            g.on = true
          }
          g.dx = Math.max(0, dx)
          setDrag(g.dx)
        },
        onTouchEnd() {
          const g = edgeRef.current
          edgeRef.current = null
          if (!g?.on) return
          const fast = g.dx / Math.max(1, Date.now() - g.at) > 0.5
          setDrag(null)
          if (g.dx > window.innerWidth * 0.33 || (fast && g.dx > 40)) goBack()
        },
        onTouchCancel() {
          edgeRef.current = null
          setDrag(null)
        },
      }

  // ---- chat list rows ----
  const typingIn = (key) =>
    Object.entries(typing.all).some(
      ([id, t]) =>
        t.until > clock - 1000 &&
        (key === 'group'
          ? t.to === null
          : key.startsWith('group:')
            ? t.to === `g:${key.slice(6)}`
            : key === `dm:${id}` && t.to === myId),
    )
  const previewFor = (key, named) => {
    const m = lastByKey[key]
    if (!m) return ''
    const body = listPreview(m)
    if (m.user_id === myId) return `You: ${body}`
    return named ? `${profiles[m.user_id] ?? 'Someone'}: ${body}` : body
  }
  const stamp = (key) => Date.parse(lastByKey[key]?.created_at ?? 0) || 0
  const listItems = [
    {
      key: 'group',
      view: { type: 'group' },
      title: 'Group Chat',
      avatar: '/logo-192.png',
      emptyText: 'Say hi to everyone 👋',
    },
    ...Object.values(groups)
      .filter((g) => g.members.includes(myId))
      .map((g) => ({
        key: `group:${g.id}`,
        view: { type: 'group', groupId: g.id },
        title: g.name,
        faces: groupFaces(g),
        emptyText: 'New group · say hi 👋',
      })),
    ...memberIds
      .filter((id) => id !== myId)
      .map((id) => ({
        key: `dm:${id}`,
        view: { type: 'dm', peerId: id },
        title: profiles[id],
        avatar: avatars[id],
        online: online.includes(id),
        ai: aiIds.has(id),
        emptyText: 'Start a private chat',
      })),
  ]
    .map((c) => ({
      ...c,
      preview: previewFor(c.key, c.key === 'group' || c.key.startsWith('group:')),
      time: listTime(lastByKey[c.key]?.created_at),
      unread: unread[c.key] ?? 0,
      typing: typingIn(c.key),
    }))
    .sort((a, b) => stamp(b.key) - stamp(a.key) || (a.key === 'group' ? -1 : b.key === 'group' ? 1 : a.title.localeCompare(b.title)))
  if (isOwner) {
    for (const g of Object.values(groups).filter((x) => !x.members.includes(myId))) {
      const key = `group:${g.id}`
      listItems.push({
        key,
        owner: true,
        view: { type: 'group', groupId: g.id },
        title: g.name,
        faces: groupFaces(g),
        preview: previewFor(key, true),
        time: listTime(lastByKey[key]?.created_at),
        unread: 0,
        stamp: stamp(key),
      })
    }
    for (const [a, b] of ownerPairList) {
      const key = `owner:${pairKey(a, b)}`
      listItems.push({
        key,
        owner: true,
        view: { type: 'owner', aId: a, bId: b },
        title: `${profiles[a]} & ${profiles[b]}`,
        faces: [a, b].map((id) => ({ id, name: profiles[id], src: avatars[id] })),
        preview: previewFor(key, true),
        time: listTime(lastByKey[key]?.created_at),
        unread: unread[key] ?? 0,
        stamp: stamp(key),
      })
    }
    listItems.sort((x, y) => (x.owner && y.owner ? y.stamp - x.stamp : 0))
  }
  const otherUnread = Object.entries(unread)
    .filter(([key]) => key !== viewKey(view))
    .reduce((sum, [, n]) => sum + n, 0)

  return (
    <div ref={shellRef} className={`shell ${wide ? 'wide' : `on-${screen}`}`}>
      <div className="pane-list-wrap" inert={!wide && screen === 'chat'}>
        <ChatList
          items={listItems}
          me={me.username}
          myAvatar={avatars[myId]}
          activeKey={chatActive ? viewKey(view) : null}
          onOpen={openConversation}
          onSettings={() => setShowSettings(true)}
          onNewGroup={isOwner ? () => setGroupSheet('create') : null}
          Avatar={Avatar}
        />
      </div>
    <div className="chat pane-chat" ref={paneRef} inert={!chatActive} {...edgeSwipe}>
      <header className="topbar">
        {/* Round glass buttons, iOS style: ‹ back to the chat list (with the
            unread count from other chats), ⋯ group info, 📞 call an AI. */}
        {!wide && (
          <button
            className="glass-btn left back"
            onClick={goBack}
            aria-label={otherUnread > 0 ? `Back to chats, ${otherUnread} unread` : 'Back to chats'}
          >
            <BackIcon />
            {otherUnread > 0 && <span className="back-count">{otherUnread > 99 ? '99+' : otherUnread}</span>}
          </button>
        )}
        {peerId && aiIds.has(peerId) ? (
          <button
            className="glass-btn right"
            onClick={() => setCallWith({ id: peerId, username: peerName })}
            aria-label={`Call ${peerName}`}
          >
            <PhoneIcon />
          </button>
        ) : (
          <button className="glass-btn right" onClick={() => setShowMembers(true)} aria-label="Chat info">
            <DotsIcon />
          </button>
        )}
        <button className="topbar-center" onClick={() => setShowMembers(true)}>
          <span className={`topbar-avatar ${isOwnerView || currentGroup ? 'pair' : ''}`}>
            {currentGroup ? (
              groupFaces(currentGroup).map((f) => <Avatar key={f.id} name={f.name} src={f.src} />)
            ) : isGroup ? (
              <img src="/logo-192.png" alt="" />
            ) : isOwnerView ? (
              <>
                <Avatar name={ownerNameA} src={avatars[ownerA]} />
                <Avatar name={ownerNameB} src={avatars[ownerB]} />
              </>
            ) : (
              <Avatar name={peerName} src={avatars[peerId]} />
            )}
          </span>
          <span className="glass-pill">
            <span className="pill-title">{isGroup ? groupTitle : isOwnerView ? ownerPairLabel : peerName}</span>
            <span className={`pill-sub ${headerTyping ? 'typing' : ''}`}>{headerSubtitle}</span>
          </span>
        </button>
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
              read={
                !readOnly &&
                item.msg.user_id === myId &&
                (isGroup
                  ? otherMemberIds.length > 0 &&
                    otherMemberIds.every((id) => (reads[item.msg.id] ?? []).includes(id))
                  : peerId
                    ? (reads[item.msg.id] ?? []).includes(peerId)
                    : false)
              }
              readOnly={readOnly}
              status={!readOnly && item.msg.id === lastOwnId ? readStatus(item.msg) : null}
              tickState={
                item.msg._status ??
                (isGroup
                  ? otherMemberIds.length > 0 && otherMemberIds.every((id) => (reads[item.msg.id] ?? []).includes(id))
                    ? 'read'
                    : (reads[item.msg.id] ?? []).some((id) => id !== myId)
                      ? 'partial'
                      : 'sent'
                  : peerId && (reads[item.msg.id] ?? []).includes(peerId)
                    ? 'read'
                    : 'sent')
              }
              onRetry={() => retrySend(item.msg)}
              replyOriginal={item.msg.reply_to_id ? originals.get(item.msg.reply_to_id) ?? null : undefined}
              onReply={() => !item.msg._status && startReply(item.msg)}
              highlightMentions={isGroup}
              myId={myId}
              username={profiles[item.msg.user_id] ?? '…'}
              avatar={avatars[item.msg.user_id]}
              profiles={profiles}
              reactions={reactions[item.msg.id] ?? []}
              url={urls[item.msg.attachment_path] ?? item.msg._localUrl}
              uploadProgress={uploadProgress[item.msg.id]}
              pickerOpen={pickerFor === item.msg.id}
              onOpenPicker={() => !item.msg._status && setPickerFor(item.msg.id)}
              onClosePicker={() => setPickerFor(null)}
              onReact={(emoji) => toggleReaction(item.msg.id, emoji)}
              onDelete={() => deleteMessage(item.msg)}
              onOpenImage={setLightbox}
              onMediaLoad={scrollToBottom}
            />
          ),
        )}
        {typing.typers.map((id) => (
          <div key={`typing-${id}`} className="row theirs first typing-row" aria-label={`${profiles[id] ?? 'Someone'} is typing`}>
            <div className="row-avatar">
              <Avatar name={profiles[id] ?? '?'} src={avatars[id]} />
            </div>
            <div className="stack">
              {isGroup && <div className="sender">{profiles[id] ?? '…'}</div>}
              <div className="pieces">
                <div className="bubble tail typing-bubble">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          </div>
        ))}
      </main>

      {error && (
        <div className="toast" onClick={() => setError('')}>
          {error}
        </div>
      )}

      {notice && (
        <div className="notice-toast" role="status" aria-live="polite">
          <button
            className="notice-main"
            onClick={() => openTarget({ key: notice.key, view: notice.view })}
            aria-label={`Open ${noticeLabel}, new message from ${noticeSender}`}
          >
            <Avatar name={noticeSender} src={avatars[notice.senderId]} />
            <span className="notice-text">
              <span className="notice-sender">
                {noticeSender} · {noticeLabel}
              </span>
              <span className="notice-preview">{notice.preview}</span>
            </span>
          </button>
          <button className="notice-close" onClick={() => setNotice(null)} aria-label="Dismiss notification">
            ✕
          </button>
        </div>
      )}

      {readOnly ? (
        <div className="owner-readonly" role="note">
          {notInGroup
            ? "Read-only · you're not in this group."
            : 'Read-only owner view · you cannot send, react, or delete here.'}
        </div>
      ) : (
        <>
          {replyTo && (
            <div className="reply-preview" role="note">
              <span className="reply-preview-text">
                <b>Replying to {profiles[replyTo.user_id] ?? '…'}</b>
                <span>{quotePreviewOf(replyTo)}</span>
              </span>
              <button className="reply-preview-cancel" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                ✕
              </button>
            </div>
          )}
          <Composer
            onSend={send}
            placeholder={isGroup ? (currentGroup ? `Message ${currentGroup.name}` : 'Message') : `Message ${peerName}`}
            enableMentions={isGroup}
            members={groupMemberIds
              .slice()
              .sort((a, b) => (profiles[a] ?? '').localeCompare(profiles[b] ?? ''))
              .map((id) => ({ id, username: profiles[id], avatar: avatars[id] }))}
            viewKey={viewKey(view)}
            onTyping={typing.notify}
            onVoiceError={setError}
          />
        </>
      )}

      </div>

      {showMembers && (
        <div className="sheet-backdrop" onClick={() => setShowMembers(false)}>
          <div className="sheet" role="dialog" aria-label="Chat info" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grabber" aria-hidden="true" />
            <div className="sheet-head">
              <span>{isGroup ? 'Group info' : isOwnerView ? 'Private chat' : 'Contact'}</span>
              <button className="sheet-done" onClick={() => setShowMembers(false)}>
                Done
              </button>
            </div>
            <div className="info-hero">
              <span className={`info-avatar ${isOwnerView || currentGroup ? 'pair' : ''}`}>
                {currentGroup ? (
                  groupFaces(currentGroup).map((f) => <Avatar key={f.id} name={f.name} src={f.src} />)
                ) : isGroup ? (
                  <img src="/logo-192.png" alt="" />
                ) : isOwnerView ? (
                  <>
                    <Avatar name={ownerNameA} src={avatars[ownerA]} />
                    <Avatar name={ownerNameB} src={avatars[ownerB]} />
                  </>
                ) : (
                  <Avatar name={peerName} src={avatars[peerId]} />
                )}
              </span>
              <span className="info-name">
                {isGroup ? groupTitle : isOwnerView ? ownerPairLabel : peerName}
                {peerId && aiIds.has(peerId) && <span className="ai-badge">AI</span>}
              </span>
              <span className="info-sub">{headerSubtitle}</span>
              {peerId && aiIds.has(peerId) && (
                <div className="info-actions">
                  <button
                    onClick={() => {
                      setShowMembers(false)
                      setCallWith({ id: peerId, username: peerName })
                    }}
                  >
                    <PhoneIcon />
                    <span>Call</span>
                  </button>
                </div>
              )}
            </div>
            {(isGroup || isOwnerView) && (
              <>
                <div className="sheet-section">{isGroup ? `${groupMemberIds.length} people` : 'In this chat'}</div>
                <ul className="member-list">
                  {isOwner && currentGroup && (
                    <li>
                      <button className="add-people" onClick={() => setGroupSheet('add')}>
                        <span className="add-people-icon">＋</span>
                        Add people
                      </button>
                    </li>
                  )}
                  {(isGroup ? groupMemberIds : [ownerA, ownerB])
                    .slice()
                    .sort((x, y) => (x === myId ? -1 : y === myId ? 1 : (profiles[x] ?? '').localeCompare(profiles[y] ?? '')))
                    .map((id) => (
                      <li key={id}>
                        <span className="member-avatar">
                          <Avatar name={profiles[id]} src={avatars[id]} />
                          {online.includes(id) && <span className="convo-online" />}
                        </span>
                        <span className="member-name">
                          {profiles[id]}
                          {aiIds.has(id) && <span className="ai-badge">AI</span>}
                          {id === myId && <span className="muted"> (you)</span>}
                        </span>
                        {id !== myId && (
                          <button className="chat-with" onClick={() => openDm(id)}>
                            Message
                          </button>
                        )}
                        {isOwner && currentGroup && id !== myId && (
                          <button className="member-remove" onClick={() => removeFromGroup(id)} aria-label={`Remove ${profiles[id]}`}>
                            −
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              </>
            )}
            {currentGroup && (
              <div className="group-actions">
                {isOwner && <button onClick={renameGroup}>Rename group</button>}
                {currentGroup.members.includes(myId) && (
                  <button className="danger" onClick={leaveGroup}>
                    Leave group
                  </button>
                )}
                {isOwner && (
                  <button className="danger" onClick={deleteGroup}>
                    Delete group
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {groupSheet && (
        <GroupSheet
          mode={groupSheet}
          Avatar={Avatar}
          people={memberIds
            .filter((id) => id !== myId && !(groupSheet === 'add' && currentGroup?.members.includes(id)))
            .sort((x, y) => (profiles[x] ?? '').localeCompare(profiles[y] ?? ''))
            .map((id) => ({ id, name: profiles[id], avatar: avatars[id], ai: aiIds.has(id) }))}
          onCancel={() => setGroupSheet(null)}
          onDone={groupSheet === 'create' ? createGroup : addToGroup}
        />
      )}

      {showSettings && (
        <div className="sheet-backdrop" onClick={() => setShowSettings(false)}>
          <div className="sheet" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grabber" aria-hidden="true" />
            <div className="sheet-head">
              <span>Settings</span>
              <button className="sheet-done" onClick={() => setShowSettings(false)}>
                Done
              </button>
            </div>
            <MyPhoto
              name={me.username}
              src={avatars[myId]}
              onPick={changeAvatar}
              onRemove={() => setAvatarPath(null)}
            />
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
            <label className="setting-row">
              <span>Notifications</span>
              <input
                type="checkbox"
                className="switch"
                checked={browserNotifications && notificationPermission === 'granted'}
                onChange={(e) => toggleBrowserNotifications(e.target.checked)}
              />
            </label>
            {notificationPermission === 'denied' && (
              <p className="setting-note muted">
                Browser notifications are blocked in your browser settings. The in-app notice still works.
              </p>
            )}
            <label className="setting-row">
              <span>Push notifications</span>
              <input
                type="checkbox"
                className="switch"
                checked={pushSubscribed}
                onChange={(e) => togglePush(e.target.checked)}
              />
            </label>
            <p className="setting-note muted">
              Push notifications can reach you even when the app is closed, including on your lock screen. On iPhone, that only works if the app is
              installed to your home screen first. See the note below the toggle if push is off.
            </p>
            {pushStatus === 'unconfigured' && <p className="setting-note muted">{pushError}</p>}
            {pushStatus === 'denied' && (
              <p className="setting-note muted">
                Push permission was not granted. The in-app notice still works.
              </p>
            )}
            {pushStatus === 'error' && pushError && <p className="setting-note muted">{pushError}</p>}
            {pushStatus === 'unsupported' && (
              <p className="setting-note muted">This browser does not support web push. The in-app notice still works.</p>
            )}
            {notificationPermission === 'unsupported' && (
              <p className="setting-note muted">This browser does not support browser notifications. The in-app notice still works.</p>
            )}
            <ApiKeys username={me.username} />
            <button className="sheet-signout" onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {lightbox && <MediaViewer item={lightbox} onClose={() => setLightbox(null)} />}
      {callWith && (
        <Suspense fallback={<div className="call-screen" />}>
          <CallScreen
            peer={callWith}
            avatar={avatars[callWith.id]}
            myName={me.username}
            onEnded={(result) => saveCall(callWith, result)}
          />
        </Suspense>
      )}
    </div>
  )
}

function Message({
  msg,
  first,
  last,
  mine,
  read = false,
  readOnly = false,
  highlightMentions = false,
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
  replyOriginal,
  onReply,
  status = null,
  tickState = 'sent',
  onRetry,
  uploadProgress,
}) {
  const pressTimer = useRef(null)
  const [copied, setCopied] = useState(false)
  // Time and ticks show under the last message of each run; tapping any
  // other message reveals its own.
  const [revealed, setRevealed] = useState(false)

  // Copy from the long-press menu (on phones the bubble text itself can't be
  // selected, because a long press opens the menu).
  async function copy() {
    const text = msg.content?.trim() ? msg.content : url ?? ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  // Swipe-to-reply: a rightward drag on touch. The threshold and the
  // horizontal-dominance check are the accidental-swipe guards: a small
  // drag does nothing, and a mostly vertical drag (scrolling) never
  // triggers a reply. touch-action: pan-y in CSS keeps vertical scrolling
  // working while the horizontal drag is tracked here.
  const swipeStart = useRef(null)
  const swipeFired = useRef(false)
  const [dragX, setDragX] = useState(0)
  const SWIPE_THRESHOLD = 60
  const swipeHandlers = readOnly
    ? {}
    : {
        onPointerDown: (e) => {
          if (e.pointerType === 'mouse') return
          swipeStart.current = { x: e.clientX, y: e.clientY }
          swipeFired.current = false
          // Swipe handlers replace the long-press gesture handlers on this
          // element, so start the tapback long-press timer here too.
          pressTimer.current = setTimeout(onOpenPicker, LONG_PRESS_MS)
        },
        onPointerMove: (e) => {
          const start = swipeStart.current
          if (!start || swipeFired.current) return
          const dx = e.clientX - start.x
          const dy = e.clientY - start.y
          if (dx <= 0 || Math.abs(dy) > Math.abs(dx) * 0.7) {
            setDragX(0)
            return
          }
          setDragX(Math.min(dx, 64))
          if (dx >= SWIPE_THRESHOLD) {
            swipeFired.current = true
            clearTimeout(pressTimer.current)
            setDragX(0)
            onReply?.()
          }
        },
        onPointerUp: () => {
          clearTimeout(pressTimer.current)
          swipeStart.current = null
          setDragX(0)
        },
        onPointerCancel: () => {
          clearTimeout(pressTimer.current)
          swipeStart.current = null
          setDragX(0)
        },
      }
  const isImage = msg.attachment_type?.startsWith('image/')
  const isVideo = msg.attachment_type?.startsWith('video/')
  const isMedia = msg.attachment_path && (isImage || isVideo)
  const isVoice = msg.attachment_path && msg.attachment_type?.startsWith('audio/')
  const isCall = msg.call_duration != null
  const isFile = msg.attachment_path && !isMedia && !isVoice
  // An image link in the text (e.g. an AI's generated image) shows as a picture.
  const linkedImages = useMemo(() => (msg.call_duration != null ? [] : imageLinksIn(msg.content)), [msg.content, msg.call_duration])
  const shownText = useMemo(() => withoutMarkdownImages(msg.content), [msg.content])

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

  // Quote for a reply: the original's sender and short preview when it is
  // loaded, a non-clickable fallback when it is deleted or not loaded.
  // Tapping a loaded quote scrolls to the original in this view.
  const quoteOf = (m) => {
    if (m.call_duration != null) return 'voice call'
    if (m.content?.trim()) {
      const text = m.content.trim()
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    }
    if (m.attachment_path) {
      if (m.attachment_type?.startsWith('image/')) return 'photo'
      if (m.attachment_type?.startsWith('video/')) return 'video'
      if (m.attachment_type?.startsWith('audio/')) return 'voice note'
      return 'file'
    }
    return 'message'
  }
  const scrollToOriginal = () => {
    if (!replyOriginal) return
    document.getElementById(`msg-${replyOriginal.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div
      id={`msg-${msg.id}`}
      className={`row ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''} ${grouped.length ? 'has-tapback' : ''} ${msg._status ? `is-${msg._status}` : ''}`}
    >
      {!mine && <div className="row-avatar">{last && <Avatar name={username} src={avatar} />}</div>}
      <div className="stack">
        {!mine && first && <div className="sender">{username}</div>}
        {msg.reply_to_id && (
          replyOriginal ? (
            <button className="quote" onClick={scrollToOriginal} title="Go to original message">
              <span className="quote-sender">{profiles[replyOriginal.user_id] ?? '…'}</span>
              <span className="quote-text">{quoteOf(replyOriginal)}</span>
            </button>
          ) : (
            <div className="quote quote-missing" role="note">
              <span className="quote-text">Original message not loaded</span>
            </div>
          )
        )}
        <div
          className="pieces"
          style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
          onClick={(e) => {
            e.stopPropagation()
            if (e.detail === 1) setRevealed((r) => !r)
          }}
          {...gestures}
          {...swipeHandlers}
        >
          {dragX > 20 && <span className="swipe-reply-hint" aria-hidden="true">↩</span>}
          {isMedia &&
            (url ? (
              isImage ? (
                <span className="media-wrap">
                  <img
                    className="media"
                    src={url}
                    alt={msg.attachment_name}
                    onLoad={onMediaLoad}
                    onClick={() => !msg._status && onOpenImage({ url, name: msg.attachment_name ?? 'photo.jpg', type: 'image' })}
                  />
                  {msg._status === 'sending' && <UploadRing progress={uploadProgress} />}
                </span>
              ) : (
                <span className="media-wrap">
                  <video className="media" src={url} controls playsInline preload="metadata" onLoadedMetadata={onMediaLoad} />
                  {msg._status === 'sending' && <UploadRing progress={uploadProgress} />}
                </span>
              )
            ) : (
              <div className="media placeholder" />
            ))}
          {isVoice && (
            <div className={`bubble voice ${tail(!msg.content)}`} aria-label={`Voice note, ${formatDuration(msg.attachment_duration)}`}>
              <VoicePlayer url={url} duration={msg.attachment_duration} seed={msg.attachment_path} />
            </div>
          )}
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
          {isCall && <CallCard msg={msg} tail={tail(true)} />}
          {shownText && !isCall && (
            <div className={`bubble ${tail(!linkedImages.length)}`} title={new Date(msg.created_at).toLocaleString()}>
              {renderMessageContent(shownText, highlightMentions ? profiles : null)}
            </div>
          )}
          {linkedImages.map((src) => (
            <img
              key={src}
              className="media linked"
              src={src}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onLoad={onMediaLoad}
              onError={(e) => (e.currentTarget.style.display = 'none')}
              onClick={() => onOpenImage({ url: src, name: decodeURIComponent(src.split('?')[0].split('/').pop() || 'image'), type: 'image' })}
            />
          ))}

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

          {!readOnly && (
            <button className="reply-hint" title="Reply" aria-label="Reply to this message" onClick={onReply}>
              ↩
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
              <div className="msg-menu">
                {msg.attachment_path && url && (
                  <button
                    onClick={() => {
                      onClosePicker()
                      saveMedia(url, msg.attachment_name ?? 'download', msg.attachment_type ?? '')
                    }}
                  >
                    Save
                  </button>
                )}
                {(msg.content?.trim() || url) && (
                  <button
                    onClick={() => {
                      onClosePicker()
                      copy()
                    }}
                  >
                    {msg.content?.trim() ? 'Copy' : 'Copy link'}
                  </button>
                )}
                <button
                  onClick={() => {
                    onClosePicker()
                    onReply?.()
                  }}
                >
                  Reply
                </button>
                {mine && (
                  <button
                    className="danger"
                    onClick={() => {
                      onClosePicker()
                      onDelete()
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {(last || revealed || copied || msg._status) && (
          <div className="ticks">
            {copied && <span className="copied-flash">Copied</span>}
            <span className="ticks-time">
              {new Date(msg.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
            {mine && !readOnly && <Ticks state={tickState} />}
          </div>
        )}
        {status &&
          (status.failed ? (
            <button className="read-status failed" onClick={onRetry}>
              <b>Not delivered</b> · Tap to retry
            </button>
          ) : (
            <div className={`read-status ${status.read ? 'read' : ''}`}>
              <b>{status.label}</b>
              {status.time ? ` ${status.time}` : ''}
            </div>
          ))}
      </div>
    </div>
  )
}

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">
    <path
      d="M6.6 3.5h2.3l1.4 4.1-1.9 1.4a12 12 0 0 0 6.6 6.6l1.4-1.9 4.1 1.4v2.3c0 1.2-1 2.1-2.2 2A16.5 16.5 0 0 1 4.6 5.7c-.1-1.2.8-2.2 2-2.2z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinejoin="round"
    />
  </svg>
)

// A finished voice call in the chat: who called, how long, and the transcript.
function CallCard({ msg, tail }) {
  const [open, setOpen] = useState(false)
  const secs = Math.round(msg.call_duration)
  const length = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return (
    <div className={`bubble call-card ${tail}`}>
      <div className="call-card-head">
        <span className="call-card-icon">
          <PhoneIcon />
        </span>
        <span className="call-card-info">
          <span className="call-card-title">Voice call</span>
          <span className="call-card-sub">{length}</span>
        </span>
      </div>
      {msg.content && (
        <>
          <button
            className="call-card-toggle"
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => !o)
            }}
          >
            {open ? 'Hide transcript' : 'Show transcript'}
          </button>
          {open && <div className="call-card-transcript">{msg.content}</div>}
        </>
      )}
    </div>
  )
}

const BackIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const DotsIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <circle cx="5.5" cy="12" r="1.9" fill="currentColor" />
    <circle cx="12" cy="12" r="1.9" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.9" fill="currentColor" />
  </svg>
)

// Circular progress over a photo/video while it uploads.
function UploadRing({ progress }) {
  const p = Math.max(0.04, Math.min(1, progress ?? 0))
  const c = 2 * Math.PI * 16
  return (
    <span className="upload-ring" role="progressbar" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}>
      <svg viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="3.5" />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="#fff"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${c * p} ${c}`}
          transform="rotate(-90 20 20)"
        />
      </svg>
    </span>
  )
}

// Message ticks, drawn as icons:
//   sending: clock · sent: one grey check · partial (group, some read): two
//   grey checks · read: two blue checks · failed: red "!"
const TICK_LABELS = { sending: 'Sending', sent: 'Sent', partial: 'Read by some', read: 'Read', failed: 'Not delivered' }
function Ticks({ state }) {
  const label = TICK_LABELS[state] ?? 'Sent'
  if (state === 'failed') {
    return (
      <span className="tick tick-failed" role="img" aria-label={label}>
        !
      </span>
    )
  }
  return (
    <svg className={`tick tick-${state}`} viewBox="0 0 18 12" role="img" aria-label={label}>
      {state === 'sending' ? (
        <>
          <circle cx="9" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9 3.6V6l1.6 1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M1.5 6.6 4.6 9.6 11 2.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          {state !== 'sent' && (
            <path d="M7.4 9.6 13.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          )}
        </>
      )}
    </svg>
  )
}

function formatReadTime(iso) {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

function Composer({ onSend, placeholder = 'Message', enableMentions = false, members = [], viewKey = '', onTyping, onVoiceError }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const [recording, setRecording] = useState(false)
  // Mention picker state, group chat only. `at` is the index of the '@'
  // being typed, `query` is the text after it, `active` is the keyboard
  // highlight. Null means no picker is open.
  const [mention, setMention] = useState(null)
  const imageInput = useRef(null)
  const cameraInput = useRef(null)
  const videoInput = useRef(null)
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
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])

  // The picker belongs to one conversation: changing conversation closes
  // it, so a mention started in the group chat never leaks into a DM.
  useEffect(() => {
    setMention(null)
  }, [viewKey])

  const canSend = !busy && (text.trim() || file)

  // Members matching the typed query, prefix matches first, then the rest
  // alphabetically. An empty query lists everyone, in username order.
  // Like the reference (WhatsApp-style), the first row is always "all"
  // when it matches the query, for mentioning every member in the chat.
  const mentionOptions = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const matches = members.filter((m) => m.username && m.username.toLowerCase().includes(q))
    matches.sort((a, b) => {
      const aStarts = a.username.toLowerCase().startsWith(q)
      const bStarts = b.username.toLowerCase().startsWith(q)
      if (aStarts !== bStarts) return aStarts ? -1 : 1
      return a.username.localeCompare(b.username)
    })
    const all = 'all'.includes(q) ? [{ id: '__all__', username: 'all', avatar: null, all: true }] : []
    return [...all, ...matches]
  }, [mention, members])

  // Recompute the picker from the caret position on every keystroke.
  // Only a '@' at the start or after whitespace starts a mention, and
  // only word characters after it are part of the query, so an email
  // address or a '@' in the middle of a word never opens the picker.
  // Deleting the '@' (or moving the caret away) closes it.
  function updateMention(value, caret) {
    if (!enableMentions) {
      setMention(null)
      return
    }
    const before = value.slice(0, caret)
    const match = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(before)
    if (!match) {
      setMention(null)
      return
    }
    setMention({ at: before.lastIndexOf('@'), query: match[1], active: 0 })
  }

  function selectMention(member) {
    if (!mention) return
    const end = mention.at + 1 + mention.query.length
    const after = text.slice(end)
    const next = `${text.slice(0, mention.at)}@${member.username}${after.startsWith(' ') ? '' : ' '}${after}`
    setText(next)
    setMention(null)
    const caret = mention.at + 1 + member.username.length + 1
    requestAnimationFrame(() => {
      const el = textRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  // Typing '@' in the message box opens the same picker, so there is
  // no separate @ button in the composer: the reference shows the list
  // appearing from typing '@' alone.
  async function submit(e) {
    e?.preventDefault()
    if (!canSend) return
    setBusy(true)
    onTyping?.(false)
    const ok = await onSend({ text: text.trim(), file })
    setBusy(false)
    if (ok) {
      setText('')
      setFile(null)
      setMention(null)
      textRef.current?.focus()
    }
  }

  // One file: preview it in the box with room for a caption. Several (from
  // Photos or Files): send each straight away, in the order picked.
  async function pick(e) {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    setMenu(false)
    if (files.length === 1) return setFile(files[0])
    for (const f of files) await onSend({ text: '', file: f })
  }

  function onPaste(e) {
    const f = [...(e.clipboardData?.files ?? [])][0]
    if (f) {
      e.preventDefault()
      setFile(f)
    }
  }

  function onComposerKeyDown(e) {
    if (!mention || !enableMentions) {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
      return
    }
    if (e.key === 'ArrowDown' && mentionOptions.length) {
      e.preventDefault()
      setMention((m) => ({ ...m, active: (m.active + 1) % mentionOptions.length }))
      return
    }
    if (e.key === 'ArrowUp' && mentionOptions.length) {
      e.preventDefault()
      setMention((m) => ({ ...m, active: (m.active - 1 + mentionOptions.length) % mentionOptions.length }))
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && mentionOptions.length) {
      e.preventDefault()
      selectMention(mentionOptions[mention.active] ?? mentionOptions[0])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
  }

  if (recording) {
    return (
      <div className="composer">
        <VoiceRecorder
          onSend={onSend}
          onCancel={() => setRecording(false)}
          onError={onVoiceError}
          onTyping={onTyping}
        />
      </div>
    )
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
      <button
        type="button"
        className={`circle-btn plus-btn ${menu ? 'open' : ''}`}
        aria-label="Add photo, video or file"
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
      >
        <PlusIcon />
      </button>
      {menu && (
        <div className="attach-backdrop" onClick={() => setMenu(false)}>
          <div className="attach-sheet" role="dialog" aria-label="Add to message" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grabber" aria-hidden="true" />
            <div className="attach-tiles">
              <button type="button" onClick={() => cameraInput.current.click()}>
                <span className="attach-icon camera"><CameraIcon /></span>
                Camera
              </button>
              <button type="button" onClick={() => imageInput.current.click()}>
                <span className="attach-icon photos"><PhotosIcon /></span>
                Photos
              </button>
              <button type="button" onClick={() => videoInput.current.click()}>
                <span className="attach-icon videos"><VideoIcon /></span>
                Videos
              </button>
            </div>
            <div className="attach-list">
              <button type="button" onClick={() => fileInput.current.click()}>
                <ClipIcon />
                <span>Add files</span>
              </button>
              {canRecordVoice() && (
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false)
                    setRecording(true)
                  }}
                >
                  <MicIcon />
                  <span>Record a voice note</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={pick} />
      <input ref={videoInput} type="file" accept="video/*" hidden onChange={pick} />
      <input ref={fileInput} type="file" multiple hidden onChange={pick} />

      {enableMentions && mention && (
        <div className="mention-picker" role="listbox" aria-label="Mention a member">
          {mentionOptions.length === 0 ? (
            <div className="mention-empty" role="status">
              No member matches @{mention.query}
            </div>
          ) : (
            mentionOptions.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={i === mention.active}
                className={`mention-option ${i === mention.active ? 'active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectMention(m)}
                onMouseEnter={() => setMention((prev) => (prev ? { ...prev, active: i } : prev))}
              >
                {m.all ? (
                  <span className="mention-all-icon" aria-hidden="true">👥</span>
                ) : (
                  <Avatar name={m.username} src={m.avatar} />
                )}
                <span className="mention-option-text">
                  <span>{m.username}</span>
                  {m.all && <span className="mention-option-sub">Mention all members in this chat</span>}
                </span>
              </button>
            ))
          )}
        </div>
      )}

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
            onChange={(e) => {
              setText(e.target.value)
              updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
              onTyping?.(e.target.value.trim().length > 0)
            }}
            onPaste={onPaste}
            onKeyDown={onComposerKeyDown}
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
          ) : canRecordVoice() ? (
            <button
              type="button"
              className="mic-btn"
              aria-label="Record a voice note"
              onClick={() => {
                setMenu(false)
                setRecording(true)
              }}
            >
              <MicIcon />
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
  // Guard: [...name] and name.slice throw on undefined/null. Most call
  // sites pass a fallback, but a missing profile must never blank the
  // whole chat, so fall back to '?' here too.
  const safeName = name ?? '?'
  const hue = [...safeName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span
      className="avatar"
      style={{ background: `linear-gradient(180deg, hsl(${hue} 55% 68%), hsl(${hue} 50% 48%))` }}
    >
      {safeName.slice(0, 1).toUpperCase()}
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
const CameraIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.3-2h5.2l1.3 2h1.6A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <circle cx="12" cy="12.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
)
const PhotosIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="9" cy="10" r="1.7" fill="currentColor" />
    <path d="M4 17l5-4.5 3.5 3 3-2.5L20 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
)
const VideoIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <rect x="3" y="6" width="13" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M16 10.5l5-3v9l-5-3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
)
const ClipIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
    <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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

// Render a sent message: links stay links, and, in the group chat only,
// @name tokens that match a real member render as a highlighted mention.
// A mention is non-interactive in this build (no popover, no filtering),
// it changes nothing about who can read the message, and it is stored as
// plain text in the existing content column, so no migration is needed.
// An @name that matches nobody renders as ordinary text, never a guess.
function renderMessageContent(text, profilesMap) {
  // Guard: text.split throws on null/undefined/non-string content. The
  // call sites already guard null, but a bad row must never blank the
  // whole chat, so render nothing for it instead of crashing.
  if (typeof text !== 'string') return []
  const mentionNames = profilesMap
    ? new Set([...Object.values(profilesMap).map((u) => (u ?? '').toLowerCase()), 'all'])
    : null
  const out = []
  let key = 0
  for (const part of text.split(/(https?:\/\/[^\s]+)/g)) {
    if (/^https?:\/\//.test(part)) {
      out.push(
        <a key={key++} href={part} target="_blank" rel="noreferrer">
          {part}
        </a>,
      )
      continue
    }
    if (!mentionNames) {
      out.push(part)
      continue
    }
    for (const seg of part.split(/(@[A-Za-z][A-Za-z0-9_.-]*)/g)) {
      if (!seg) continue
      if (seg.startsWith('@') && mentionNames.has(seg.slice(1).toLowerCase())) {
        out.push(
          <span key={key++} className="mention">
            {seg}
          </span>,
        )
      } else {
        out.push(seg)
      }
    }
  }
  return out
}

function linkify(text) {
  return renderMessageContent(text, null)
}
