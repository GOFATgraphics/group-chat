import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { SHOW_FOR_MS, applyPresenceEvent, sweepPresence } from './workingStatus.js'

// "Someone is typing" over a Supabase Realtime broadcast channel. Nothing is
// stored. Each event says who is typing and where: to: null for the group
// chat, or the recipient's id for a private message. A bubble shows for a few
// seconds after the last event, and disappears as soon as that person's
// message arrives. AI members send the same event through POST /api/typing.
//
// Working status is typing with a label: an agent posts
// POST /api/typing { "working": "Getting documents…" } and the same event
// carries `working`, so the app shows the animated working state with the
// label instead of the plain typing bubble. It shares typing's heartbeat
// and expiry — a stuck status disappears on its own.

export const TYPING_CHANNEL = 'typing'
const RESEND_EVERY_MS = 2500

// target: null in the main group chat, "g:<id>" in a named group, the peer's id
// in a private chat, undefined where typing should be neither sent nor shown
// (the owner's read-only view).
export function useTyping(myId, target) {
  const [typing, setTyping] = useState({}) // userId -> { to, until, working }
  const channelRef = useRef(null)
  const lastSent = useRef(0)

  useEffect(() => {
    if (!myId) return
    const channel = supabase
      .channel(TYPING_CHANNEL, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const id = payload?.user_id
        if (!id || id === myId) return
        setTyping((prev) => applyPresenceEvent(prev, payload))
      })
      .subscribe()
    channelRef.current = channel

    const sweep = setInterval(() => {
      setTyping((prev) => sweepPresence(prev))
    }, 1000)

    return () => {
      clearInterval(sweep)
      channelRef.current = null
      supabase.removeChannel(channel)
    }
  }, [myId])

  // Call with true on every keystroke (throttled here) and false when the
  // message is sent or the box is emptied.
  const notify = useCallback(
    (isTyping) => {
      if (target === undefined || !channelRef.current) return
      const now = Date.now()
      if (isTyping && now - lastSent.current < RESEND_EVERY_MS) return
      if (!isTyping && lastSent.current === 0) return
      lastSent.current = isTyping ? now : 0
      channelRef.current.send({
        type: 'broadcast',
        event: 'typing',
        payload: { user_id: myId, to: target, typing: isTyping },
      })
    },
    [myId, target],
  )

  // Switching conversation stops "typing" in the old one.
  useEffect(() => () => notify(false), [notify])

  const clear = useCallback((userId) => {
    setTyping((prev) => {
      if (!prev[userId]) return prev
      const next = { ...prev }
      delete next[userId]
      return next
    })
  }, [])

  // In this conversation: the group chat (to === null), a named group
  // (to === "g:<id>"), or a DM where the peer is typing to me.
  const inView = ([id, v]) =>
    target === null || String(target).startsWith('g:')
      ? v.to === target
      : target !== undefined && id === target && v.to === myId

  const typers = Object.entries(typing).filter(inView).map(([id]) => id)

  // Whoever is working in this conversation: [{ id, label }], and the
  // same as a lookup { userId: label }. A working entry is also a typer —
  // the bubble and the header show the label instead of the dots.
  const workers = Object.entries(typing)
    .filter((entry) => inView(entry) && entry[1].working)
    .map(([id, v]) => ({ id, label: v.working }))
  const workingById = Object.fromEntries(workers.map((w) => [w.id, w.label]))

  // Everyone typing anywhere you can see: { userId: { to, until, working } }, for the chat list.
  return { typers, workers, workingById, notify, clear, all: typing }
}
