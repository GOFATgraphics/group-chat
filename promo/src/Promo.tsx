import React from 'react'
import { AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { Phone, Tex, Crop } from './Phone'
import { APP_EASE, E, FLY_EASE, ip, lerp, prog } from './motion'

// Group Chat promo. 1920x1080 @ 30fps, rendered at 2x scale for 4K.
// SHOTS is the single source of truth: captions, sound cues and transitions
// are all expressed relative to it.

export const SHOTS = {
  open: { from: 0, dur: 115 },
  hero: { from: 105, dur: 200 },
  live: { from: 300, dur: 215 },
  title: { from: 510, dur: 62 },
  ai: { from: 568, dur: 182 },
  media: { from: 745, dur: 150 },
  tools: { from: 890, dur: 190 },
  outro: { from: 1075, dur: 150 },
} as const
export const DURATION = SHOTS.outro.from + SHOTS.outro.dur // 1225 f ≈ 40.8 s

const FONT = "'Inter Display', Inter, -apple-system, sans-serif"
const BLUE = '#0b84fe'
const INK = '#0b0b0f'
const MUTED = '#6e6e76'

// ---- shared pieces ---------------------------------------------------------

const Background: React.FC = () => {
  const f = useCurrentFrame()
  const drift = (a: number, sp: number) => Math.sin(f / sp + a) * 60
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #f9fbff 0%, #eef2f8 100%)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', width: 1100, height: 1100, left: -260 + drift(0, 90), top: -420 + drift(1, 110), borderRadius: '50%', background: 'radial-gradient(circle, rgba(11,132,254,0.16), rgba(11,132,254,0) 65%)' }} />
      <div style={{ position: 'absolute', width: 1000, height: 1000, right: -280 + drift(2, 100), bottom: -460 + drift(3, 120), borderRadius: '50%', background: 'radial-gradient(circle, rgba(125,92,255,0.13), rgba(125,92,255,0) 65%)' }} />
      <div style={{ position: 'absolute', width: 700, height: 700, right: 380 + drift(4, 80), top: -300, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,159,10,0.08), rgba(255,159,10,0) 65%)' }} />
    </AbsoluteFill>
  )
}

// blur-slide (video-shotcraft card): words rise out of blur, one after another.
const Words: React.FC<{ text: string; at: number; gap?: number; dy?: number; style?: React.CSSProperties; accent?: string[] }> = ({ text, at, gap = 3.5, dy = 40, style, accent = [] }) => {
  const f = useCurrentFrame()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '0.28em', ...style }}>
      {text.split(' ').map((w, i) => {
        const p = prog(f, at + i * gap, at + i * gap + 20, E.outCubic)
        const isAccent = accent.includes(w.replace(/[.,!?]/g, ''))
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: p,
              transform: `translateY(${lerp(p, dy, 0)}px)`,
              filter: `blur(${(1 - p) * 10}px)`,
              ...(isAccent ? { background: 'linear-gradient(90deg, #0b84fe, #7d5cff)', WebkitBackgroundClip: 'text', color: 'transparent' } : {}),
            }}
          >
            {w}
          </span>
        )
      })}
    </div>
  )
}

// Big caption block beside a phone: title + supporting line, with an exit.
const Caption: React.FC<{ title: string; sub: string; at: number; out: number; x?: number; y?: number; width?: number; accent?: string[]; align?: 'left' | 'center' }> = ({ title, sub, at, out, x = 150, y = 380, width = 760, accent, align = 'left' }) => {
  const f = useCurrentFrame()
  const exit = prog(f, out, out + 14, E.inCubic)
  return (
    <div style={{ position: 'absolute', left: x, top: y, width, opacity: 1 - exit, transform: `translateY(${-30 * exit}px)`, filter: `blur(${exit * 8}px)`, textAlign: align }}>
      <Words text={title} at={at} accent={accent} style={{ fontFamily: FONT, fontWeight: 800, fontSize: 76, lineHeight: 1.04, letterSpacing: '-0.035em', color: INK, justifyContent: align === 'center' ? 'center' : 'flex-start' }} />
      <Words text={sub} at={at + 14} gap={2.5} dy={26} style={{ marginTop: 26, fontFamily: FONT, fontWeight: 500, fontSize: 36, lineHeight: 1.3, color: MUTED, letterSpacing: '-0.01em', justifyContent: align === 'center' ? 'center' : 'flex-start' }} />
    </div>
  )
}

// A phone that enters from below with a settling tilt, then holds.
const usePhoneIn = (at: number, dur = 34) => {
  const f = useCurrentFrame()
  const p = prog(f, at, at + dur, APP_EASE)
  return { p, y: lerp(p, 900, 0), rotY: lerp(p, 28, 0), rotX: lerp(p, 10, 0), opacity: prog(f, at, at + 8) }
}

const Tap: React.FC<{ x: number; y: number; at: number }> = ({ x, y, at }) => {
  const f = useCurrentFrame()
  const p = prog(f, at, at + 18, E.outCubic)
  if (f < at || f > at + 20) return null
  return (
    <div style={{ position: 'absolute', left: x - 30, top: y - 30, width: 60, height: 60, borderRadius: '50%', background: 'rgba(11,132,254,0.18)', border: '2px solid rgba(11,132,254,0.45)', transform: `scale(${0.4 + p})`, opacity: 1 - p }} />
  )
}

// ---- shots -----------------------------------------------------------------

const Open: React.FC = () => {
  const f = useCurrentFrame()
  const logo = prog(f, 4, 34, FLY_EASE)
  const exit = prog(f, 92, 112, E.inCubic)
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: 1 - exit, transform: `translateY(${-80 * exit}px) scale(${1 - 0.06 * exit})`, filter: `blur(${exit * 10}px)` }}>
      <div style={{ position: 'relative', width: 230, height: 230, marginBottom: 36 }}>
        <div style={{ position: 'absolute', inset: -120, borderRadius: '50%', background: 'radial-gradient(circle, rgba(11,132,254,0.28), rgba(11,132,254,0) 60%)', opacity: logo, transform: `scale(${0.6 + 0.4 * logo})` }} />
        <Img src={staticFile('logo.png')} style={{ position: 'absolute', inset: 0, width: 230, height: 230, transform: `scale(${lerp(logo, 0.55, 1)}) rotate(${lerp(logo, -12, 0)}deg)`, opacity: prog(f, 4, 14), filter: `blur(${(1 - prog(f, 4, 26)) * 14}px) drop-shadow(0 24px 40px rgba(11,132,254,0.35))` }} />
      </div>
      <Words text="Group Chat" at={20} gap={5} style={{ fontFamily: FONT, fontWeight: 800, fontSize: 132, letterSpacing: '-0.045em', color: INK, lineHeight: 1 }} />
      <Words text="Your team and your AI, in one chat." at={36} gap={2.6} dy={24} accent={['AI']} style={{ marginTop: 26, fontFamily: FONT, fontWeight: 500, fontSize: 42, color: MUTED, letterSpacing: '-0.015em' }} />
    </AbsoluteFill>
  )
}

const Hero: React.FC = () => {
  const f = useCurrentFrame()
  const ph = usePhoneIn(8, 46)
  const float = Math.sin(f / 26) * 6 * prog(f, 54, 80)
  // tap "Group Chat" (row 1 at y≈150 in the screen) then slide in the chat
  const slide = prog(f, 138, 160, APP_EASE)
  const exit = prog(f, 186, 200, E.inCubic)
  return (
    <AbsoluteFill>
      <Caption title="Every chat in one beautiful list." sub="Groups, private chats and your AI teammates, with unread, typing and online at a glance." at={30} out={180} accent={['beautiful']} />
      <div style={{ position: 'absolute', left: 1080, top: 105, perspective: 1600 }}>
        <div style={{ transform: `translateY(${ph.y + float - 40 * exit}px) rotateY(${ph.rotY - 14 * exit}deg) rotateX(${ph.rotX}deg)`, opacity: ph.opacity * (1 - exit) }}>
          <Phone zoom={1.0}>
            <Tex name="list" style={{ transform: `translateX(${-28 * slide}%)`, filter: `brightness(${1 - 0.08 * slide})` }} />
            <Tex name="group-0" style={{ transform: `translateX(${100 - 100 * slide}%)`, boxShadow: slide > 0 && slide < 1 ? '-12px 0 30px rgba(0,0,0,.12)' : undefined }} />
            <Tap x={110} y={150} at={128} />
          </Phone>
        </div>
      </div>
    </AbsoluteFill>
  )
}

const Live: React.FC = () => {
  const f = useCurrentFrame()
  // camera: push in on the lower half of the chat
  const cam = prog(f, 0, 40, APP_EASE)
  const zoom = lerp(cam, 1.0, 1.42)
  const x = lerp(cam, 1080, 860)
  const y = lerp(cam, 105, -210)
  const typing = prog(f, 48, 62, FLY_EASE)
  const typingOut = prog(f, 98, 104)
  const reply = prog(f, 100, 116, FLY_EASE)
  const read = prog(f, 112, 124, E.outCubic)
  const heart = prog(f, 150, 164, FLY_EASE)
  const exit = prog(f, 200, 215, E.inCubic)
  return (
    <AbsoluteFill>
      <Caption title="Typing, reactions and read receipts. Live." sub="Messages arrive instantly, for people and for AIs." at={22} out={196} x={110} y={330} width={700} accent={['Live.']} />
      <div style={{ position: 'absolute', left: x, top: y, opacity: 1 - exit, transform: `translateX(${400 * exit}px)` }}>
        <Phone zoom={zoom}>
          <Tex name="group-0" />
          {/* header: "ali is typing…" while the bubble shows */}
          <Crop name="group-1" x={0} y={0} w={390} h={125} style={{ opacity: typing * (1 - typingOut) }} />
          <Crop name="group-1" x={0} y={570} w={390} h={56} origin="10% 80%" style={{ opacity: typing * (1 - typingOut), transform: `scale(${lerp(typing, 0.5, 1)})` }} />
          {/* the reply lands and the ticks turn blue */}
          <Crop name="group-2" x={0} y={570} w={390} h={75} origin="10% 80%" style={{ opacity: Math.min(1, reply * 1.6) * (1 - heart), transform: `scale(${lerp(reply, 0.8, 1)}) translateY(${lerp(reply, 12, 0)}px)` }} />
          <Crop name="group-2" x={200} y={530} w={190} h={38} style={{ opacity: read, background: '#fff' }} />
          {/* ❤️ tapback: the row moves down to make room (as in the app) */}
          <Crop name="group-3" x={0} y={560} w={390} h={95} style={{ opacity: Math.min(1, heart * 2) }} />
          <Crop name="group-3" x={250} y={578} w={52} h={38} origin="50% 60%" style={{ opacity: heart, transform: `scale(${lerp(heart, 0, 1)})` }} />
        </Phone>
      </div>
    </AbsoluteFill>
  )
}

const Title: React.FC = () => {
  const f = useCurrentFrame()
  const exit = prog(f, 48, 62, E.inCubic)
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: 1 - exit, filter: `blur(${exit * 10}px)` }}>
      <Words text="Meet your AI teammates." at={2} gap={4} accent={['AI']} style={{ fontFamily: FONT, fontWeight: 800, fontSize: 118, letterSpacing: '-0.045em', color: INK, justifyContent: 'center' }} />
      <Words text="Adam and Ali live in your chat." at={14} gap={2.6} dy={24} style={{ marginTop: 24, fontFamily: FONT, fontWeight: 500, fontSize: 42, color: MUTED, justifyContent: 'center' }} />
    </AbsoluteFill>
  )
}

const AI: React.FC = () => {
  const f = useCurrentFrame()
  const a = usePhoneIn(0, 38)
  const b = usePhoneIn(12, 38)
  const exit = prog(f, 166, 182, E.inCubic)
  const ring = (k: number) => ((f / 40 + k) % 1)
  return (
    <AbsoluteFill>
      <Caption title="Voice notes, photos and live calls." sub="Adam and Ali answer in their own voices." at={18} out={164} x={0} y={70} width={1920} align="center" />
      <div style={{ position: 'absolute', left: 520, top: 300, perspective: 1600, opacity: 1 - exit }}>
        <div style={{ transform: `translateY(${a.y + 60 * exit}px) rotateY(${a.rotY + 8}deg) rotateX(${a.rotX}deg)`, opacity: a.opacity }}>
          <Phone zoom={0.84}>
            <Tex name="dm-adam" />
          </Phone>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1020, top: 300, perspective: 1600, opacity: 1 - exit }}>
        <div style={{ transform: `translateY(${b.y + 60 * exit}px) rotateY(${b.rotY - 8}deg) rotateX(${b.rotX}deg)`, opacity: b.opacity }}>
          <Phone zoom={0.84} dark>
            <Tex name="call" />
            {[0, 0.5].map((k) => (
              <div key={k} style={{ position: 'absolute', left: 195 - 60, top: 118 - 60, width: 120, height: 120, borderRadius: '50%', border: '2px solid rgba(90,200,250,0.6)', transform: `scale(${1 + ring(k) * 0.9})`, opacity: (1 - ring(k)) * prog(f, 40, 60) }} />
            ))}
          </Phone>
        </div>
      </div>
    </AbsoluteFill>
  )
}

const Media: React.FC = () => {
  const f = useCurrentFrame()
  const ph = usePhoneIn(0, 34)
  const menu = prog(f, 36, 50, FLY_EASE)
  const toViewer = prog(f, 82, 96, APP_EASE)
  const chrome = prog(f, 112, 120)
  const exit = prog(f, 136, 150, E.inCubic)
  const att = { x: 12, y: 313, w: 330, h: 414 }
  return (
    <AbsoluteFill>
      <Caption title="Photos, files and voice. One tap." sub="The + menu brings everything in, and photos open full screen." at={20} out={132} accent={['One', 'tap.']} />
      <div style={{ position: 'absolute', left: 1080, top: 105, perspective: 1600, opacity: 1 - exit }}>
        <div style={{ transform: `translateY(${ph.y - 50 * exit}px) rotateY(${ph.rotY}deg)`, opacity: ph.opacity }}>
          <Phone zoom={1.0}>
            <Tex name="group-3" />
            <Tex name="attach" style={{ opacity: menu * (1 - toViewer) }} />
            <Crop name="attach" x={att.x} y={att.y} w={att.w} h={att.h} origin="10% 100%" style={{ opacity: menu * (1 - toViewer), transform: `scale(${lerp(menu, 0.6, 1)})` }} />
            <Tap x={70} y={402} at={74} />
            <Tex name="viewer" style={{ opacity: toViewer, transform: `scale(${lerp(toViewer, 0.85, 1)})` }} />
            <Tex name="viewer-chrome" style={{ opacity: toViewer * chrome }} />
          </Phone>
        </div>
      </div>
    </AbsoluteFill>
  )
}

const Tools: React.FC = () => {
  const f = useCurrentFrame()
  const ph = usePhoneIn(0, 34)
  const sent = prog(f, 52, 62)
  const votes = prog(f, 82, 100, FLY_EASE)
  const notes = prog(f, 108, 140, APP_EASE)
  const exit = prog(f, 175, 190, E.inCubic)
  const card = { x: 60, y: 300, w: 330, h: 270 }
  return (
    <AbsoluteFill>
      <Caption title="Polls, tasks and decisions." sub="Mubarak makes groups with anyone. The AIs can search, pin, vote and keep the notes." at={18} out={172} x={110} y={360} width={640} accent={['decisions.']} />
      <div style={{ position: 'absolute', left: 840, top: 105, perspective: 1600, opacity: 1 - exit }}>
        <div style={{ transform: `translateY(${ph.y}px) rotateY(${ph.rotY - 6 * notes}deg) translateX(${-80 * notes}px)`, opacity: ph.opacity }}>
          <Phone zoom={1.0}>
            <Tex name="poll-compose" />
            <Tex name="poll-0" style={{ opacity: sent }} />
            <Crop name="poll-1" x={card.x} y={card.y} w={card.w} h={card.h} origin="100% 50%" style={{ opacity: votes, transform: `scaleX(${lerp(votes, 0.92, 1)})` }} />
          </Phone>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1330, top: 160, perspective: 1600, opacity: notes * (1 - exit) }}>
        <div style={{ transform: `translateX(${lerp(notes, 260, 0)}px) rotateY(${lerp(notes, -30, -10)}deg)` }}>
          <Phone zoom={0.86}>
            <Tex name="notes" />
          </Phone>
        </div>
      </div>
    </AbsoluteFill>
  )
}

// outro-group-photo-launch (video-shotcraft card): pieces from every scene fly
// in around the wordmark; crane settle; stage light; hold.
type Piece = { name: string; x: number; y: number; w: number; h: number; cx: number; cy: number; scale: number; rot: number; dx: number; dy: number; cue: number; radius: number }
const PIECES: Piece[] = [
  { name: 'list', x: 8, y: 191, w: 374, h: 74, cx: 360, cy: 230, scale: 1.25, rot: -4, dx: -520, dy: -80, cue: 4, radius: 18 },
  { name: 'group-3', x: 14, y: 578, w: 300, h: 72, cx: 1560, cy: 240, scale: 1.35, rot: 4, dx: 520, dy: -60, cue: 7, radius: 18 },
  { name: 'dm-adam', x: 40, y: 270, w: 240, h: 56, cx: 330, cy: 820, scale: 1.4, rot: 3, dx: -480, dy: 260, cue: 10, radius: 28 },
  { name: 'poll-1', x: 60, y: 310, w: 330, h: 130, cx: 1560, cy: 820, scale: 1.15, rot: -3, dx: 480, dy: 260, cue: 13, radius: 22 },
  { name: 'attach', x: 12, y: 313, w: 330, h: 160, cx: 330, cy: 525, scale: 0.95, rot: -2, dx: -560, dy: 0, cue: 16, radius: 30 },
  { name: 'notes', x: 8, y: 604, w: 374, h: 62, cx: 1590, cy: 530, scale: 0.95, rot: 2.5, dx: 560, dy: 0, cue: 19, radius: 18 },
]

const Outro: React.FC = () => {
  const f = useCurrentFrame()
  const crane = prog(f, 0, 40, Easing3)
  const push = prog(f, 40, 150)
  const recede = prog(f, 42, 52)
  const stage = ip(f, [42, 52, 64], [0, 0.55, 0.3])
  const rule = prog(f, 60, 72, E.outCubic)
  const tag = prog(f, 70, 84)
  const fade = prog(f, 138, 150)
  return (
    <AbsoluteFill style={{ opacity: 1 - fade }}>
      <AbsoluteFill style={{ transform: `perspective(1400px) rotateX(${4 * (1 - crane)}deg) scale(${1.06 - 0.06 * crane + 0.035 * push})`, transformOrigin: '50% 45%' }}>
        {PIECES.map((p) => {
          if (f < p.cue) return null
          const t = prog(f, p.cue, p.cue + 14, FLY_EASE)
          const air = Math.max(0, 1 - t)
          return (
            <div
              key={p.name + p.cue}
              style={{
                position: 'absolute',
                left: p.cx - (p.w * p.scale) / 2,
                top: p.cy - (p.h * p.scale) / 2,
                width: p.w * p.scale,
                height: p.h * p.scale,
                borderRadius: p.radius,
                overflow: 'hidden',
                background: '#fff',
                boxShadow: `0 ${16 + 24 * air}px ${40 + 40 * air}px rgba(20,40,90,${0.16 + 0.08 * air}), 0 0 0 1px rgba(0,0,0,0.04)`,
                transform: `translate(${p.dx * (1 - t)}px, ${p.dy * (1 - t)}px) rotate(${p.rot * (2 - t)}deg) scale(${1.1 - 0.1 * t})`,
                opacity: prog(f, p.cue, p.cue + 4) * (1 - 0.14 * recede),
              }}
            >
              <div style={{ zoom: p.scale }}>
                <Crop name={p.name} x={p.x} y={p.y} w={p.w} h={p.h} style={{ position: 'relative', left: 0, top: 0 }} />
              </div>
            </div>
          )
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(760px 420px at 960px 520px, rgba(255,255,255,0.98), rgba(255,255,255,0.4) 55%, rgba(255,255,255,0) 75%)', opacity: stage }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
          <Img src={staticFile('logo.png')} style={{ width: 150, height: 150, opacity: prog(f, 40, 48), transform: `scale(${lerp(prog(f, 40, 54, FLY_EASE), 0.5, 1)})`, filter: 'drop-shadow(0 16px 30px rgba(11,132,254,0.35))' }} />
          <div style={{ display: 'flex', fontFamily: FONT, fontWeight: 800, fontSize: 140, letterSpacing: '-0.045em', color: INK }}>
            {'Group Chat'.split('').map((ch, i) => {
              const d = 44 + i * 1.8
              const t = prog(f, d, d + 9, E.outCubic)
              return (
                <span key={i} style={{ display: 'inline-block', whiteSpace: 'pre', opacity: t, transform: `translateY(${(1 - t) * 28}px) scale(${1.3 - 0.3 * t})`, filter: `blur(${(1 - t) * 8}px)` }}>
                  {ch}
                </span>
              )
            })}
          </div>
        </div>
        <div style={{ height: 6, width: 300, marginTop: 30, borderRadius: 3, background: `linear-gradient(90deg, ${BLUE}, #7d5cff)`, transform: `scaleX(${rule})` }} />
        <div style={{ marginTop: 28, fontFamily: FONT, fontWeight: 600, fontSize: 44, color: MUTED, letterSpacing: '-0.01em', opacity: tag, transform: `translateY(${(1 - tag) * 16}px)` }}>
          Your team. Your AIs. One chat.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
function Easing3(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

// ---- sound: every cue tied to a shot (S2: declarative, relative) ------------
type Sfx = { from: number; src: string; volume: number; dur?: number }
const S = SHOTS
export const SFX: Sfx[] = [
  { from: S.open.from + 4, src: 'sparkle-touch.mp3', volume: 0.45 }, // logo blooms
  { from: S.open.from + 20, src: 'transition-soft.mp3', volume: 0.3 }, // wordmark rises
  { from: S.hero.from + 6, src: 'whoosh-fast.mp3', volume: 0.42 }, // phone rises
  { from: S.hero.from + 128, src: 'switch-tap.mp3', volume: 0.55 }, // tap Group Chat
  { from: S.hero.from + 136, src: 'swoosh-quick.mp3', volume: 0.32 }, // chat slides in
  { from: S.live.from + 2, src: 'air-woosh-quick.mp3', volume: 0.3 }, // camera push
  { from: S.live.from + 48, src: 'pop.mp3', volume: 0.3 }, // typing bubble
  { from: S.live.from + 100, src: 'pop.mp3', volume: 0.45 }, // reply lands
  { from: S.live.from + 150, src: 'pop.mp3', volume: 0.5 }, // ❤️ tapback
  { from: S.live.from + 152, src: 'sparkle-touch.mp3', volume: 0.3 },
  { from: S.title.from, src: 'transition-soft.mp3', volume: 0.32 }, // title card
  { from: S.ai.from, src: 'swoosh-quick.mp3', volume: 0.35 }, // phone 1
  { from: S.ai.from + 12, src: 'swoosh-quick.mp3', volume: 0.28 }, // phone 2
  { from: S.media.from, src: 'whoosh-fast.mp3', volume: 0.32 }, // phone in
  { from: S.media.from + 34, src: 'switch-tap.mp3', volume: 0.5 }, // + tapped
  { from: S.media.from + 74, src: 'switch-tap.mp3', volume: 0.45 }, // Photos tapped
  { from: S.media.from + 82, src: 'click-camera.mp3', volume: 0.35 }, // photo opens
  { from: S.tools.from, src: 'whoosh-fast.mp3', volume: 0.3 },
  { from: S.tools.from + 52, src: 'swoosh-quick.mp3', volume: 0.3 }, // poll sent
  { from: S.tools.from + 82, src: 'pop.mp3', volume: 0.42 }, // votes fill
  { from: S.tools.from + 90, src: 'pop.mp3', volume: 0.32 },
  { from: S.tools.from + 108, src: 'swoosh-slow.mp3', volume: 0.3, dur: 40 }, // notes slide in
  { from: S.outro.from - 30, src: 'riser-cine.mp3', volume: 0.4, dur: 72 }, // build into outro
  { from: S.outro.from + 44, src: 'impact-deep-whoosh.mp3', volume: 0.58 }, // wordmark lands
  { from: S.outro.from + 60, src: 'sparkle.mp3', volume: 0.35 }, // rule
]

export const Promo: React.FC<{ bgm?: boolean }> = ({ bgm = true }) => {
  const f = useCurrentFrame()
  const music = interpolate(f, [0, 20, DURATION - 40, DURATION], [0, 0.3, 0.3, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ background: '#f4f6fa' }}>
      <Background />
      {(Object.keys(SHOTS) as (keyof typeof SHOTS)[]).map((k) => {
        const C = { open: Open, hero: Hero, live: Live, title: Title, ai: AI, media: Media, tools: Tools, outro: Outro }[k]
        return (
          <Sequence key={k} from={SHOTS[k].from} durationInFrames={SHOTS[k].dur}>
            <C />
          </Sequence>
        )
      })}
      {bgm && <Audio src={staticFile('audio/bgm-tech-house.mp3')} volume={() => music} />}
      {SFX.map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={s.dur ?? 60}>
          <Audio src={staticFile(`audio/${s.src}`)} volume={s.volume} />
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}
