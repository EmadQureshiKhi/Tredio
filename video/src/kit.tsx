// The motion kit, in Tredio's editorial voice: Newsreader Light headlines, Hanken Grotesk labels,
// lavender for the brand, lime for the one word that matters. Every scene composes these.
// All timing is in frames at 60 fps; `f` is always the absolute frame of the film.
import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useVideoConfig } from 'remotion';

import { C, FONT } from './brand';
import timeline from './timeline.json';

export { C };

export const DISPLAY: React.CSSProperties = { fontFamily: FONT.display, fontWeight: 300, letterSpacing: '-0.02em', lineHeight: 1.02 };
export const BODY: React.CSSProperties = { fontFamily: FONT.body, fontWeight: 300, letterSpacing: '0' };
export const LABEL: React.CSSProperties = { fontFamily: FONT.strong, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.18em' };
export const MONO: React.CSSProperties = { fontFamily: FONT.mono, fontWeight: 400, letterSpacing: '0' };

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const outExpo = Easing.bezier(0.16, 1, 0.3, 1);
export const inOut = Easing.bezier(0.45, 0, 0.2, 1);
/** 0 -> 1 over `dur` frames from `at`, eased; 0 before, 1 after. */
export const t = (f: number, at: number, dur = 12, ease = outExpo) => interpolate(f, [at, at + dur], [0, 1], { ...clamp, easing: ease });
/** Frames since the last musical hit in timeline.hits. */
export function sinceHit(f: number) {
  const last = [...timeline.hits].reverse().find((h) => h <= f) ?? -999;
  return f - last;
}
export const BEAT = timeline.beat;
export const BAR = timeline.bar;

/** The current format: landscape 1920x1080 or the 1080x1350 vertical cut. */
export function useFormat() {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  return { W: width, H: height, vertical, pick: <T,>(landscape: T, portrait: T) => (vertical ? portrait : landscape) };
}

// ---- backgrounds -----------------------------------------------------------------------------------

/** Ink, faint diagonal hairlines drifting slowly, and a soft lavender glow that wanders. */
export function Backdrop({ f }: { f: number }) {
  const drift = (f * 0.3) % 40;
  const gx = 50 + Math.sin(f / 240) * 18;
  const gy = 42 + Math.cos(f / 300) * 10;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill style={{ backgroundImage: `repeating-linear-gradient(-45deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 40px)`, backgroundPosition: `${drift}px 0` }} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 55% at ${gx}% ${gy}%, rgba(164,155,240,0.13), transparent 70%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 45%, ${C.bg} 100%)` }} />
    </AbsoluteFill>
  );
}

// ---- type ------------------------------------------------------------------------------------------

/** A headline that lands on a hit: a short overshoot in scale with a lavender and lime ghost that settles. */
export function Slam({ f, at, children, size, color = C.text, ghost = true, style }: { f: number; at: number; children: React.ReactNode; size: number; color?: string; ghost?: boolean; style?: React.CSSProperties }) {
  const base: React.CSSProperties = { ...DISPLAY, fontSize: size, whiteSpace: 'nowrap', ...style };
  // Before its hit it still holds its place, so nothing around it jumps when it lands.
  if (f < at) return <div style={{ ...base, visibility: 'hidden' }}>{children}</div>;
  const k = t(f, at, 14);
  const off = ghost ? interpolate(f - at, [0, 10], [10, 0], clamp) : 0;
  return (
    <div style={{ position: 'relative', transform: `scale(${interpolate(k, [0, 1], [1.16, 1])})`, opacity: interpolate(f - at, [0, 4], [0, 1], clamp) }}>
      {off > 0.5 && (
        <>
          <div style={{ ...base, position: 'absolute', inset: 0, color: C.primary, transform: `translateX(${-off}px)`, opacity: 0.55 }}>{children}</div>
          <div style={{ ...base, position: 'absolute', inset: 0, color: C.accent, transform: `translateX(${off}px)`, opacity: 0.45 }}>{children}</div>
        </>
      )}
      <div style={{ ...base, position: 'relative', color }}>{children}</div>
    </div>
  );
}

/** Rises from below behind a mask: the explainer entrance. */
export function Rise({ f, at, children, size, color = C.text, dur = 18, style }: { f: number; at: number; children: React.ReactNode; size: number; color?: string; dur?: number; style?: React.CSSProperties }) {
  const k = t(f, at, dur);
  return (
    <div style={{ overflow: 'hidden', paddingBottom: size * 0.12, marginBottom: -size * 0.12 }}>
      <div style={{ ...DISPLAY, fontSize: size, color, whiteSpace: 'nowrap', transform: `translateY(${(1 - k) * 115}%)`, ...style }}>{children}</div>
    </div>
  );
}

/** Words that land one per `every` frames. `accent` indexes get the lime, `brand` indexes the lavender. */
export function WordByWord({ f, at, text, size, every = 6, color = C.text, accent = [] as number[], brand = [] as number[], align = 'center' as 'center' | 'flex-start', maxWidth = 1600 }: { f: number; at: number; text: string; size: number; every?: number; color?: string; accent?: number[]; brand?: number[]; align?: 'center' | 'flex-start'; maxWidth?: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: `0 ${size * 0.24}px`, justifyContent: align, maxWidth }}>
      {text.split(' ').map((w, i) => {
        const k = t(f, at + i * every, 12);
        return (
          <span key={i} style={{ ...DISPLAY, fontSize: size, color: accent.includes(i) ? C.accent : brand.includes(i) ? C.primary : color, opacity: k, transform: `translateY(${(1 - k) * 28}px)`, display: 'inline-block' }}>
            {w}
          </span>
        );
      })}
    </div>
  );
}

/** A small uppercase label, as the app's eyebrows ("ATTENTION MARKETS"). */
export function Eyebrow({ children, size = 22, color = C.primary, style }: { children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties }) {
  return <div style={{ ...LABEL, fontSize: size, color, ...style }}>{children}</div>;
}

/** A number that counts up to `to`. Only real numbers. */
export function Counter({ f, at, to, dur = 40, size, decimals = 0, color = C.text, style }: { f: number; at: number; to: number; dur?: number; size: number; decimals?: number; color?: string; style?: React.CSSProperties }) {
  const v = to * t(f, at, dur, Easing.bezier(0.2, 0.8, 0.2, 1));
  return (
    <div style={{ ...DISPLAY, fontSize: size, color, fontVariantNumeric: 'lining-nums proportional-nums', ...style }}>
      {v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
    </div>
  );
}

// ---- chrome ---------------------------------------------------------------------------------------

/** A numbered chapter chip: "01 MARKETS". */
export function Label({ f, at, n, text, x = 80, y = 64 }: { f: number; at: number; n: string; text: string; x?: number; y?: number }) {
  const k = t(f, at, 16);
  return (
    <div style={{ position: 'absolute', left: x, top: y, display: 'flex', alignItems: 'center', gap: 14, padding: '9px 18px 9px 9px', borderRadius: 999, background: 'rgba(17,17,19,0.88)', border: `1px solid ${C.lineStrong}`, opacity: k, transform: `translateX(${(1 - k) * -24}px)` }}>
      <div style={{ ...LABEL, fontSize: 18, letterSpacing: '0.08em', color: C.onPrimary, background: C.primary, padding: '6px 11px', borderRadius: 999 }}>{n}</div>
      <div style={{ ...LABEL, fontSize: 18, color: C.text }}>{text}</div>
    </div>
  );
}

/** A caption plate over footage: a headline and an optional line under it, as an app card. */
export function Caption({ f, at, title, sub, eyebrow, side = 'left', bottom = 72, size = 66 }: { f: number; at: number; title: React.ReactNode; sub?: React.ReactNode; eyebrow?: [string, string]; side?: 'left' | 'right'; bottom?: number; size?: number }) {
  if (f < at) return null;
  const k = t(f, at, 18);
  return (
    <div style={{ position: 'absolute', [side]: 80, bottom, maxWidth: 1300, padding: '24px 34px 28px', borderRadius: 22, background: 'rgba(17,17,19,0.92)', border: `1px solid ${C.lineStrong}`, boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)', opacity: k, transform: `translateY(${(1 - k) * 26}px)` }}>
      {eyebrow && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ ...LABEL, fontSize: 16, letterSpacing: '0.08em', color: C.onPrimary, background: C.primary, padding: '5px 10px', borderRadius: 999 }}>{eyebrow[0]}</div>
          <div style={{ ...LABEL, fontSize: 16, color: C.primary }}>{eyebrow[1]}</div>
        </div>
      )}
      <Slam f={f} at={at} size={size} ghost={false}>{title}</Slam>
      {sub && <div style={{ ...BODY, fontSize: 28, color: C.text2, marginTop: 12, opacity: t(f, at + 8, 14) }}>{sub}</div>}
    </div>
  );
}

/** A full-screen flash of a colour on a hit (0 before `at`). */
export function Flash({ f, at, dur = 14, strength = 0.8, color = C.primary }: { f: number; at: number; dur?: number; strength?: number; color?: string }) {
  const o = f < at ? 0 : interpolate(f, [at, at + dur], [strength, 0], clamp);
  return <AbsoluteFill style={{ background: color, opacity: o, pointerEvents: 'none' }} />;
}

// ---- real footage -----------------------------------------------------------------------------------

export type Rect = [x: number, y: number, w: number, h: number];
export type Key = { at: number; rect: Rect };
export type Box = { x: number; y: number; w: number; h: number };

/** CSS-pixel sizes of the captures (scripts/capture.mjs: 1600 wide at device scale 2). */
const SIZES: Record<string, [number, number]> = { 'trend-full.png': [1600, 2379], 'status-full.png': [1600, 1920] };

function camAt(f: number, keys: Key[]): Rect {
  if (f <= keys[0].at) return keys[0].rect;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (f <= b.at) {
      const p = interpolate(f, [a.at, b.at], [0, 1], { ...clamp, easing: inOut });
      return a.rect.map((v, j) => v + (b.rect[j] - v) * p) as Rect;
    }
  }
  return keys[keys.length - 1].rect;
}

/**
 * A real capture with a camera on it: the camera rect (capture CSS pixels) is fitted to cover `box`,
 * moving between keys with an in-out ease. Children are overlays in capture CSS pixels, so a ring
 * or a cursor sits on the real element whatever the camera does.
 */
export function Shot({ f, src, keys, box, round = 0, fade = 0, from = -1, children }: { f: number; src: string; keys: Key[]; box: Box; round?: number; fade?: number; from?: number; children?: React.ReactNode }) {
  const [cw, ch] = SIZES[src] ?? [1600, 900];
  const [x, y, w, h] = camAt(f, keys);
  const s = Math.max(box.w / w, box.h / h);
  const tx = box.x + (box.w - w * s) / 2 - x * s;
  const ty = box.y + (box.h - h * s) / 2 - y * s;
  const o = fade > 0 && from >= 0 ? t(f, from, fade) : 1;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, overflow: 'hidden', borderRadius: round, opacity: o }}>
      <div style={{ position: 'absolute', left: tx - box.x, top: ty - box.y, width: cw, height: ch, transform: `scale(${s})`, transformOrigin: '0 0' }}>
        <Img src={staticFile(`captures/${src}`)} style={{ width: cw, height: ch, display: 'block' }} />
        {children}
      </div>
    </div>
  );
}

/** A focus ring on a real element (capture CSS pixels), in the app's own focus colour. */
export function Ring({ f, at, rect, radius = 12, until = Infinity, color = C.primary }: { f: number; at: number; rect: Rect; radius?: number; until?: number; color?: string }) {
  if (f < at || f >= until) return null;
  const k = t(f, at, 18);
  const glow = 0.5 + 0.5 * Math.sin((f - at) / 7);
  const [x, y, w, h] = rect;
  const pad = 4;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - pad,
        top: y - pad,
        width: w + pad * 2,
        height: h + pad * 2,
        borderRadius: radius + pad,
        border: `2px solid ${color}`,
        boxShadow: `0 0 ${10 + glow * 14}px ${color}99, inset 0 0 ${6 + glow * 6}px ${color}44`,
        opacity: k,
        transform: `scale(${interpolate(k, [0, 1], [1.12, 1])})`,
      }}
    />
  );
}

/** Types `text` one character every `cpf` frames, with a block caret. */
export function TypeLine({ f, at, text, cpf = 1, style, caret = true }: { f: number; at: number; text: string; cpf?: number; style?: React.CSSProperties; caret?: boolean }) {
  if (f < at) return null;
  const n = Math.min(text.length, Math.floor((f - at) / cpf));
  const blink = n < text.length || Math.floor(f / 15) % 2 === 0;
  return (
    <div style={{ whiteSpace: 'pre', ...style }}>
      {text.slice(0, n)}
      {caret && blink && <span style={{ display: 'inline-block', width: '0.55em', height: '1.05em', verticalAlign: '-0.15em', background: C.primary, marginLeft: 2 }} />}
    </div>
  );
}

/** A pointer that follows waypoints (capture CSS pixels) and clicks at each frame in `clicks`. */
export function PathCursor({ f, points, clicks = [], size = 26 }: { f: number; points: { at: number; x: number; y: number }[]; clicks?: number[]; size?: number }) {
  if (f < points[0].at) return null;
  let x = points[0].x;
  let y = points[0].y;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (f >= a.at) {
      const p = interpolate(f, [a.at, b.at], [0, 1], { ...clamp, easing: Easing.bezier(0.3, 0, 0.2, 1) });
      x = a.x + (b.x - a.x) * p;
      y = a.y + (b.y - a.y) * p;
    }
  }
  const click = [...clicks].reverse().find((c) => c <= f);
  const pressed = click !== undefined && f < click + 7;
  const ripple = click !== undefined ? t(f, click, 24) : 1;
  return (
    <>
      {ripple < 1 && <div style={{ position: 'absolute', left: x - 28 * ripple, top: y - 28 * ripple, width: 56 * ripple, height: 56 * ripple, borderRadius: '50%', border: `2px solid ${C.text}`, opacity: 1 - ripple }} />}
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', left: x - size * 0.12, top: y - size * 0.06, transform: `scale(${pressed ? 0.86 : 1})`, transformOrigin: '10% 6%', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.6))', opacity: t(f, points[0].at, 8) }}>
        <path d="M3 2l7 19 2.5-7.5L20 11z" fill={C.text} stroke={C.bg} strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </>
  );
}
