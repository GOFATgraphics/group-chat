import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase.js'

// "Someone is typing" over a Supabase Realtime broadcast channel. Nothing is
// stored. Each event says who is typing and where: to: null for the group
// chat, or the recipient's id for a private message. A bubble shows for a few
// seconds after the last event, and disappears as soon as that person's
// message arrives. AI members send the same event through POST /api/typing.

export const TYPING_CHANNEL = 'typing'
const SHOW_FOR_MS = 6000
const RESEND_EVERY_MS = 2500

// target: null in the main group chat, "g:<id>" in a named group, the peer's id
// in a private chat, undefined where typing should be neither sent nor shown
// (the owner's read-only view).
export function useTyping(myId, target) {
  const [typing, setTyping] = useState({}) // userId -> { to, until }
  const channelRef = useRef(null)
  const lastSent = useRef(0)

  useEffect(() => {
    if (!myId) return
    const channel = supabase
      .channel(TYPING_CHANNEL, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const id = payload?.user_id
        if (!id || id === myId) return
        setTyping((prev) => {
          const next = { ...prev }
          if (payload.typing === false) delete next[id]
          else next[id] = { to: payload.to ?? null, until: Date.now() + SHOW_FOR_MS }
          return next
        })
      })
      .subscribe()
    channelRef.current = channel

    const sweep = setInterval(() => {
      setTyping((prev) => {
        const now = Date.now()
        const live = Object.entries(prev).filter(([, v]) => v.until > now)
        return live.length === Object.keys(prev).length ? prev : Object.fromEntries(live)
      })
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

  const typers = Object.entries(typing)
    .filter(([id, v]) =>
      target === null || String(target).startsWith('g:')
        ? v.to === target
        : target !== undefined && id === target && v.to === myId,
    )
    .map(([id]) => id)

  // Everyone typing anywhere you can see: { userId: { to, until } }, for the chat list.
  return { typers, notify, clear, all: typing }
}
