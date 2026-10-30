// Easing + timing helpers (from video-shotcraft demos/_fixtures/Motion.tsx).
import { Easing, interpolate } from 'remotion'

export const E = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  outQuint: (t: number) => 1 - Math.pow(1 - t, 5),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  inCubic: (t: number) => t * t * t,
}
// The app's own motion curve (styles.css: cubic-bezier(0.22, 0.8, 0.25, 1)).
export const APP_EASE = Easing.bezier(0.22, 0.8, 0.25, 1)
// Landing with a real overshoot (y1 > 1), per the outro card.
export const FLY_EASE = Easing.bezier(0.34, 1.4, 0.44, 1)

export const lerp = (t: number, a: number, b: number) => a + (b - a) * t
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
// progress of frame f through [a, b], eased
export const prog = (f: number, a: number, b: number, ease: (x: number) => number = (x) => x) =>
  ease(clamp01((f - a) / (b - a)))
export const ip = (f: number, input: number[], output: number[], easing?: (x: number) => number) =>
  interpolate(f, input, output, { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing })
