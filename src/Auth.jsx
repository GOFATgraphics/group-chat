import { useEffect, useState } from 'react'
import Login from './Login.jsx'
import Signup from './Signup.jsx'

// The auth screen: Log in or Sign up, as one screen with a toggle.
// The mode is also addressable by #signup / #login, so a link can send
// a visitor straight to signup.
export default function Auth() {
  const [mode, setMode] = useState(() =>
    typeof window !== 'undefined' && window.location.hash === '#signup' ? 'signup' : 'login',
  )

  useEffect(() => {
    const onHash = () => setMode(window.location.hash === '#signup' ? 'signup' : 'login')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (next) => {
    setMode(next)
    try {
      history.replaceState(null, '', next === 'signup' ? '#signup' : '#login')
    } catch {
      // A hash we cannot set is not worth failing the screen over.
    }
  }

  return mode === 'signup' ? (
    <Signup onGoLogin={() => go('login')} />
  ) : (
    <Login onGoSignup={() => go('signup')} />
  )
}
