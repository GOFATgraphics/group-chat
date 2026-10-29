// Small UI sounds synthesized with Web Audio, so there are no audio files to load.
// Browsers (iOS especially) only allow audio after a user gesture, so the
// context is created/resumed on the first tap or key press.

const STORAGE_KEY = 'chat-sounds'
let ctx = null

export function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  if (!ctx) ctx = new AC()
  if (ctx.state === 'suspended') ctx.resume()
}

export function soundsEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setSoundsEnabled(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // storage unavailable (private mode); the toggle just won't persist
  }
}

function ready() {
  return ctx && ctx.state === 'running' && soundsEnabled()
}

// One enveloped oscillator note, optionally gliding to another pitch.
function note(freq, start, duration, { type = 'sine', volume = 0.2, glideTo } = {}) {
  const t = ctx.currentTime + start
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + duration)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t)
  osc.stop(t + duration + 0.02)
}

// Airy upward "whoosh" for a sent message.
export function playSend() {
  if (!ready()) return
  const t = ctx.currentTime
  const length = 0.22
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise = ctx.createBufferSource()
  noise.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 1.4
  filter.frequency.setValueAtTime(700, t)
  filter.frequency.exponentialRampToValueAtTime(4500, t + length)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.35, t + 0.05)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
  noise.connect(filter).connect(gain).connect(ctx.destination)
  noise.start(t)
  noise.stop(t + length)
  note(420, 0, 0.16, { volume: 0.08, glideTo: 1200 })
}

// Soft two-note chime for an incoming message.
export function playReceive() {
  if (!ready()) return
  note(1046.5, 0, 0.32, { volume: 0.16 })
  note(1568, 0.09, 0.45, { volume: 0.14 })
  note(3136, 0.09, 0.2, { type: 'triangle', volume: 0.02 })
}

// Quick pop for adding a tapback.
export function playPop() {
  if (!ready()) return
  note(520, 0, 0.09, { volume: 0.14, glideTo: 980 })
}
