import React from 'react'
import { Img, staticFile } from 'remotion'

// An iPhone-style frame around a 390x797 app screen (the captured screens sit
// below a 47px status bar). Sized in CSS px and enlarged with CSS zoom, so the
// 4x screenshots are rasterised sharp (aesthetic rule Q2), never upscaled.
export const SCREEN_W = 390
export const SCREEN_H = 844
export const STATUS_H = 47
const BEZEL = 13

export const Phone: React.FC<{
  zoom?: number
  dark?: boolean
  style?: React.CSSProperties
  children: React.ReactNode
}> = ({ zoom = 1, dark = false, style, children }) => (
  <div style={{ position: 'absolute', zoom, ...style }}>
    <div
      style={{
        position: 'relative',
        width: SCREEN_W + BEZEL * 2,
        height: SCREEN_H + BEZEL * 2,
        borderRadius: 68,
        background: 'linear-gradient(145deg, #3a3a3e, #121214 40%, #2c2c30)',
        boxShadow:
          '0 0 0 1.5px #5b5b60, 0 2px 0 2px #1a1a1c, 0 40px 80px rgba(20,30,60,.28), 0 12px 28px rgba(20,30,60,.18)',
        padding: BEZEL,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: SCREEN_W,
          height: SCREEN_H,
          borderRadius: 55,
          overflow: 'hidden',
          background: dark ? '#000' : '#fff',
        }}
      >
        <StatusBar dark={dark} />
        <div style={{ position: 'absolute', left: 0, top: STATUS_H, width: SCREEN_W, height: SCREEN_H - STATUS_H, overflow: 'hidden' }}>
          {children}
        </div>
        {/* dynamic island */}
        <div style={{ position: 'absolute', left: SCREEN_W / 2 - 62, top: 11, width: 124, height: 36, borderRadius: 20, background: '#000' }} />
        {/* home indicator */}
        <div style={{ position: 'absolute', left: SCREEN_W / 2 - 68, bottom: 8, width: 136, height: 5, borderRadius: 3, background: dark ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.85)' }} />
        {/* glass sheen */}
        <div style={{ position: 'absolute', inset: 0, borderRadius: 55, background: 'linear-gradient(115deg, rgba(255,255,255,.10), rgba(255,255,255,0) 32%)', pointerEvents: 'none' }} />
      </div>
    </div>
  </div>
)

const StatusBar: React.FC<{ dark: boolean }> = ({ dark }) => {
  const c = dark ? '#fff' : '#000'
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: SCREEN_W, height: STATUS_H, background: dark ? '#000' : '#fff', zIndex: 2 }}>
      <div style={{ position: 'absolute', left: 52, top: 15, font: '600 17px Inter, sans-serif', color: c, letterSpacing: '-0.01em' }}>9:41</div>
      <svg style={{ position: 'absolute', right: 30, top: 18 }} width="78" height="14" viewBox="0 0 78 14">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={i * 5.5} y={10 - i * 3} width="3.6" height={3 + i * 3} rx="1" fill={c} />
        ))}
        <path d="M33 5.2a8.5 8.5 0 0 1 11.8 0M35.4 7.7a5 5 0 0 1 7 0M37.8 10.2a1.6 1.6 0 0 1 2.2 0" stroke={c} strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <rect x="51" y="1.5" width="22" height="11" rx="3.2" fill="none" stroke={c} strokeOpacity=".45" strokeWidth="1" />
        <rect x="53" y="3.5" width="16" height="7" rx="1.6" fill={c} />
        <rect x="74.3" y="5" width="1.6" height="4" rx=".8" fill={c} fillOpacity=".45" />
      </svg>
    </div>
  )
}

// A full captured screen.
export const Tex: React.FC<{ name: string; style?: React.CSSProperties }> = ({ name, style }) => (
  <Img src={staticFile(`tex/${name}.png`)} style={{ position: 'absolute', left: 0, top: 0, width: 390, height: 797, ...style }} />
)

// One rectangle of a captured screen, shown in place (x/y/w/h in screen CSS px).
export const Crop: React.FC<{
  name: string
  x: number
  y: number
  w: number
  h: number
  style?: React.CSSProperties
  origin?: string
}> = ({ name, x, y, w, h, style, origin }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, overflow: 'hidden', transformOrigin: origin ?? 'center', ...style }}>
    <Img src={staticFile(`tex/${name}.png`)} style={{ position: 'absolute', left: -x, top: -y, width: 390, height: 797, maxWidth: 'none' }} />
  </div>
)
