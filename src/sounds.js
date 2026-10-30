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

// Everything plays through a small room reverb and a gentle limiter, so the
// sounds feel soft and glassy (iMessage-like) instead of raw beeps. Built
// once per audio context. All sounds are our own synthesis, no Apple audio.
const chains = new WeakMap()
function out(c) {
  if (chains.has(c)) return chains.get(c)
  const master = c.createDynamicsCompressor()
  master.threshold.value = -18
  master.ratio.value = 4
  const level = c.createGain()
  level.gain.value = 2 // phone speakers: about -7 dB peak
  master.connect(level).connect(c.destination)
  const dry = c.createGain()
  dry.gain.value = 0.9
  dry.connect(master)
  const reverb = c.createConvolver()
  const len = Math.floor(c.sampleRate * 0.9)
  const ir = c.createBuffer(2, len, c.sampleRate)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1 // fixed, no Math.random
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = rnd() * Math.pow(1 - i / len, 3.2)
  }
  reverb.buffer = ir
  const wet = c.createGain()
  wet.gain.value = 0.16
  reverb.connect(wet).connect(master)
  const chain = { input: c.createGain() }
  chain.input.connect(dry)
  chain.input.connect(reverb)
  chains.set(c, chain)
  return chain
}

// One enveloped tone, optionally gliding, panned.
function tone(c, freq, start, duration, { type = 'sine', volume = 0.2, glideTo, attack = 0.006, pan = 0 } = {}) {
  const t = c.currentTime + start
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + duration * 0.8)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)
  let node = osc.connect(gain)
  if (pan && c.createStereoPanner) {
    const p = c.createStereoPanner()
    p.pan.value = pan
    node = node.connect(p)
  }
  node.connect(out(c).input)
  osc.start(t)
  osc.stop(t + duration + 0.05)
}

// A glass-like strike: a pure fundamental plus quickly fading inharmonic
// partials, which is what makes it read as "glass" instead of "beep".
function glass(c, freq, start, volume) {
  tone(c, freq, start, 0.55, { volume })
  tone(c, freq * 2.76, start, 0.16, { volume: volume * 0.22 })
  tone(c, freq * 5.4, start, 0.07, { volume: volume * 0.08 })
}

// Filtered noise sweep (the "air" in a whoosh).
function air(c, start, length, { from, to, volume, q = 0.9 }) {
  const t = c.currentTime + start
  const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * length), c.sampleRate)
  const data = buffer.getChannelData(0)
  let seed = 11
  for (let i = 0; i < data.length; i++) data[i] = ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buffer
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = q
  bp.frequency.setValueAtTime(from, t)
  bp.frequency.exponentialRampToValueAtTime(to, t + length * 0.85)
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + length * 0.35)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
  let node = src.connect(bp).connect(gain)
  if (c.createStereoPanner) {
    const p = c.createStereoPanner()
    p.pan.setValueAtTime(-0.35, t)
    p.pan.linearRampToValueAtTime(0.35, t + length)
    node = node.connect(p)
  }
  node.connect(out(c).input)
  src.start(t)
  src.stop(t + length)
}

export const SOUNDS = {
  // Sent: a soft airy swoosh rising and moving left to right.
  send(c) {
    air(c, 0, 0.34, { from: 500, to: 5200, volume: 0.42 })
    tone(c, 330, 0.02, 0.24, { volume: 0.05, glideTo: 990, attack: 0.04 })
  },
  // Received: two gentle glass notes, a rising fourth.
  receive(c) {
    glass(c, 1318.5, 0, 0.17)
    glass(c, 1760, 0.11, 0.15)
  },
  // Reaction: a light bubble pop.
  pop(c) {
    tone(c, 380, 0, 0.11, { volume: 0.2, glideTo: 1150, attack: 0.003 })
    tone(c, 2400, 0, 0.03, { type: 'triangle', volume: 0.025, attack: 0.002 })
  },
}

export function playSend() {
  if (ready()) SOUNDS.send(ctx)
}
export function playReceive() {
  if (ready()) SOUNDS.receive(ctx)
}
export function playPop() {
  if (ready()) SOUNDS.pop(ctx)
}
