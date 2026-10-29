import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import Login from './Login.jsx'
import Chat from './Chat.jsx'

export default function App() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (session === undefined) return <div className="splash">Loading…</div>
  return session ? <Chat session={session} /> : <Login />
}
