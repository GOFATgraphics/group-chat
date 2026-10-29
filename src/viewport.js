// Keep the app exactly the size of the visible area. On iPhone the on-screen
// keyboard does not resize the page; it scrolls it instead, which pushes the
// header off screen. Sizing the app to visualViewport and pinning the page at
// the top keeps the header visible and the input bar just above the keyboard.

export function trackViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement

  const sync = () => {
    root.style.setProperty('--app-height', `${vv.height}px`)
    root.style.setProperty('--app-top', `${vv.offsetTop}px`)
    root.classList.toggle('keyboard-open', window.innerHeight - vv.height > 120)
    if (window.scrollY !== 0) window.scrollTo(0, 0)
    window.dispatchEvent(new Event('app-viewport'))
  }

  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  sync()
}
