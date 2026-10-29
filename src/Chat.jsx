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
  // A push notification that opens the app carries the conversation in
  // the URL (?view=dm&peer=… or ?view=owner&a=…&b=…), so a cold start
  // from a lock-screen tap lands in the right conversation, not just the
  // group chat. Panel navigation does not rewrite the URL.
  const [view, setView] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('view') === 'dm' && params.get('peer')) return { type: 'dm', peerId: params.get('peer') }
      if (params.get('view') === 'owner' && params.get('a') && params.get('b')) {
        return { type: 'owner', aId: params.get('a'), bId: params.get('b') }
      }
    } catch {
      // ignore a malformed URL and start in the group chat
    }
    return { type: 'group' }
  })
  const [showPanel, setShowPanel] = useState(false)
  const [dmPeers, setDmPeers] = useState([])
  const [ownerPairs, setOwnerPairs] = useState([])
  const [lightbox, setLightbox] = useState(null)
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
  const isOwnerRef = useRef(false)
  useEffect(() => {
    isOwnerRef.current = me?.username === 'mubarak'
  }, [me])
  useEffect(() => {
    setReplyTo(null)
  }, [view])

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

  // ---- realtime notifications --------------------------------------------
  // Unread keys: 'group', 'dm:<peerId>', 'owner:<a>|<b>'. The key, not the
  // message, is what the panel badge and the document title count, so a
  // message in the currently viewed conversation never creates a count.
  const viewKey = (v) => {
    if (v.type === 'group') return 'group'
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

  const previewOf = (m) => {
    if (m.content?.trim()) {
      const text = m.content.trim()
      return text.length > 80 ? `${text.slice(0, 80)}…` : text
    }
    if (m.attachment_path) {
      if (m.attachment_type?.startsWith('image/')) return 'sent a photo'
      if (m.attachment_type?.startsWith('video/')) return 'sent a video'
      return 'sent a file'
    }
    return 'sent a message'
  }

  const openTarget = useCallback(
    (target) => {
      clearUnread(target.key)
      setNotice(null)
      setView(target.view)
      setShowMembers(false)
      setShowPanel(false)
    },
    [clearUnread],
  )

  // The single place a realtime arrival becomes a notification. Own
  // messages and messages in the currently viewed conversation never reach
  // here from the realtime handler, so they get no toast and no count.
  // The toast replaces any previous toast (latest wins, never a stack).
  const notify = useCallback(
    (m) => {
      const target = notifyTarget(m)
      const preview = previewOf(m)
      setUnread((prev) => ({ ...prev, [target.key]: (prev[target.key] ?? 0) + 1 }))
      setNotice({ key: target.key, view: target.view, senderId: m.user_id, preview, owner: target.owner })
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
    if (m.content?.trim()) {
      const text = m.content.trim()
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    }
    if (m.attachment_path) {
      if (m.attachment_type?.startsWith('image/')) return 'photo'
      if (m.attachment_type?.startsWith('video/')) return 'video'
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
  useEffect(() => {
    clearUnread(viewKey(view))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  useEffect(() => {
    const onFocus = () => {
      if (!document.hidden) clearUnread(viewKey(viewRef.current))
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
      if (v.type === 'group') setView({ type: 'group' })
      else if (v.type === 'dm' && v.peerId) setView({ type: 'dm', peerId: v.peerId })
      else if (v.type === 'owner' && v.aId && v.bId && isOwnerRef.current) {
        setView({ type: 'owner', aId: v.aId, bId: v.bId })
      }
      setShowPanel(false)
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
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
    if (!vapidKey) {
      // No key is invented here. Until a real VAPID key pair is generated
      // and the public key is set (see docs/web-push.md), push stays off.
      setPushStatus('unconfigured')
      setPushError('Push is not configured yet: the app needs a VAPID public key. No key was created.')
      return
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
          // it is not added to the current view, but it does notify.
          if (m.user_id !== myId) {
            playReceive()
            notify(m)
          }
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
        const ids = new Set(
          Object.values(channel.presenceState())
            .flat()
            .map((p) => p?.user_id)
            .filter(Boolean),
        )
        setOnline([...ids])
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') channel.track({ user_id: myId })
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [myId, addMessage, applyReaction, dmPeerOf, addDmPeer, addOwnerPair, ensureProfile, isMessageForView, notify])

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
    // A reply only quotes a message from the conversation being sent in.
    // replyTo is cleared on every view change, so this check is a second
    // line: if the quoted message is no longer in this view, send plain.
    const replyToId = replyTo && messages.some((m) => m.id === replyTo.id) ? replyTo.id : null
    const { data, error: insErr } = await supabase
      .from('messages')
      .insert({ content: text || null, recipient_id: peerId, reply_to_id: replyToId, ...attachment })
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
    setReplyTo(null)
    return true
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

  const noticeSender = notice ? profiles[notice.senderId] ?? 'Someone' : null
  const noticeLabel = notice
    ? notice.owner
      ? `Owner view · ${profiles[notice.view.aId] ?? '…'} and ${profiles[notice.view.bId] ?? '…'}`
      : notice.view.type === 'group'
        ? 'Group Chat'
        : profiles[notice.view.peerId] ?? 'Private chat'
    : null

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
              replyOriginal={item.msg.reply_to_id ? originals.get(item.msg.reply_to_id) ?? null : undefined}
              onReply={() => startReply(item.msg)}
              highlightMentions={isGroup}
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

      {isOwnerView ? (
        <div className="owner-readonly" role="note">
          Read-only owner view · you cannot send, react, or delete here.
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
            placeholder={isGroup ? 'Message' : `Message ${peerName}`}
            enableMentions={isGroup}
            members={memberIds
              .slice()
              .sort((a, b) => (profiles[a] ?? '').localeCompare(profiles[b] ?? ''))
              .map((id) => ({ id, username: profiles[id], avatar: avatars[id] }))}
            viewKey={isGroup ? 'group' : `dm:${peerId}`}
          />
        </>
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
              {unread.group > 0 && (
                <span className="unread-badge" aria-label={`${unread.group} unread`}>
                  {unread.group > 99 ? '99+' : unread.group}
                </span>
              )}
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
                      aria-label={`Chat with ${profiles[id]}${online.includes(id) ? ' (online)' : ''}${unread[`dm:${id}`] > 0 ? `, ${unread[`dm:${id}`]} unread` : ''}`}
                      onClick={() => openDm(id)}
                    >
                      <Avatar name={profiles[id]} src={avatars[id]} />
                      <span className="dm-name">{profiles[id]}</span>
                      {unread[`dm:${id}`] > 0 && (
                        <span className="unread-badge" aria-label={`${unread[`dm:${id}`]} unread`}>
                          {unread[`dm:${id}`] > 99 ? '99+' : unread[`dm:${id}`]}
                        </span>
                      )}
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
                            {unread[`owner:${pairKey(a, b)}`] > 0 && (
                              <span className="unread-badge" aria-label={`${unread[`owner:${pairKey(a, b)}`]} unread`}>
                                {unread[`owner:${pairKey(a, b)}`] > 99 ? '99+' : unread[`owner:${pairKey(a, b)}`]}
                              </span>
                            )}
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
}) {
  const pressTimer = useRef(null)
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

  // Quote for a reply: the original's sender and short preview when it is
  // loaded, a non-clickable fallback when it is deleted or not loaded.
  // Tapping a loaded quote scrolls to the original in this view.
  const quoteOf = (m) => {
    if (m.content?.trim()) {
      const text = m.content.trim()
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    }
    if (m.attachment_path) {
      if (m.attachment_type?.startsWith('image/')) return 'photo'
      if (m.attachment_type?.startsWith('video/')) return 'video'
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
      className={`row ${mine ? 'mine' : 'theirs'} ${first ? 'first' : ''} ${grouped.length ? 'has-tapback' : ''}`}
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
          onClick={(e) => e.stopPropagation()}
          {...gestures}
          {...swipeHandlers}
        >
          {dragX > 20 && <span className="swipe-reply-hint" aria-hidden="true">↩</span>}
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
              {renderMessageContent(msg.content, highlightMentions ? profiles : null)}
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
      </div>
    </div>
  )
}

function Composer({ onSend, placeholder = 'Message', enableMentions = false, members = [], viewKey = '' }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  // Mention picker state, group chat only. `at` is the index of the '@'
  // being typed, `query` is the text after it, `active` is the keyboard
  // highlight. Null means no picker is open.
  const [mention, setMention] = useState(null)
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
    return matches
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

  // The tag button inserts '@' at the caret and opens the same picker
  // that typing '@' opens, so touch users never need to find '@' on
  // their keyboard.
  function insertMentionTrigger() {
    const el = textRef.current
    const caret = el ? (el.selectionStart ?? text.length) : text.length
    const next = `${text.slice(0, caret)}@${text.slice(caret)}`
    setText(next)
    setMention({ at: caret, query: '', active: 0 })
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(caret + 1, caret + 1)
    })
  }

  async function submit(e) {
    e?.preventDefault()
    if (!canSend) return
    setBusy(true)
    const ok = await onSend({ text: text.trim(), file })
    setBusy(false)
    if (ok) {
      setText('')
      setFile(null)
      setMention(null)
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
      {enableMentions && (
        <button
          type="button"
          className="circle-btn mention-btn"
          aria-label="Mention a member"
          title="Mention a member"
          onClick={insertMentionTrigger}
        >
          @
        </button>
      )}
      <input ref={imageInput} type="file" accept="image/*,video/*" hidden onChange={pick} />
      <input ref={fileInput} type="file" hidden onChange={pick} />

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
                <Avatar name={m.username} src={m.avatar} />
                <span>@{m.username}</span>
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
    ? new Set(Object.values(profilesMap).map((u) => (u ?? '').toLowerCase()))
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
