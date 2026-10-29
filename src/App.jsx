import { Component, useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import Login from './Login.jsx'
import Chat from './Chat.jsx'
import Splash from './Splash.jsx'

// Safety net added after the 2026-10-29 blank-page incident: without an
// error boundary, a render or effect error in Chat unmounts the whole
// React tree, leaving a white blank page with no explanation. With this
// boundary, the user instead sees the error message and a reload button,
// and the chat renders normally when there is no error. It does not catch
// errors in event handlers or async callbacks, only render/effect errors.
class ChatErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    // Kept for diagnosis: the message is also shown in the fallback UI.
    console.error('Group chat failed to render:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="login-page">
          <div className="login-card">
            <h1>Something went wrong</h1>
            <p className="muted">
              {this.state.error?.message || 'The chat could not be shown.'}
            </p>
            <button className="primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (session === undefined) return <Splash />
  return session ? (
    <ChatErrorBoundary>
      <Chat session={session} />
    </ChatErrorBoundary>
  ) : (
    <Login />
  )
}
