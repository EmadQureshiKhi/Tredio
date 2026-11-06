// The first card scenes (frames 1030 to 1376): topic cards pop onto the purple, the grid bends into a
// concave wall under "Topics the world is talking about." and "Now Tradeable", a whip pan swaps it for
// a grid of tokens that flattens, then a white flash on the beat.
import React from 'react';
import { AbsoluteFill, Easing, interpolate } from 'remotion';

import { CARD_H, CARD_W, TRENDS, TrendCard } from './Card';
import { H, HF } from './look';
import { T } from './timing';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const inOut = Easing.bezier(0.45, 0, 0.25, 1);
const outCubic = Easing.bezier(0.2, 0.7, 0.3, 1);

/** Perspective of the wall, in px, and the radii of its bend at full curvature (horizontal and vertical). */
const P = 1000;
const RX = 950;
const RY = 760;

type Grid = { ids: string[]; cols: number[]; rows: number[]; scale: number };
/** The topic grid as it lands (screen px from the frame's centre), then the token grid. */
const GRID_A: Grid = { ids: ['worldCup', 'agents', 'heatwave', 'stables', 'rates', 'mars'], cols: [-577, 5, 587], rows: [-202, 176], scale: 0.995 };
const GRID_B: Grid = { ids: ['btc', 'eth', 'near', 'hype', 'stables', 'worldCup'], cols: [-541, 51, 637], rows: [-157, 217], scale: 1.032 };

/**
 * Where a card sits on the bent wall: `gx`, `gy` are its flat position, `k` the curvature (0 flat, 1 full).
 * The wall is the inside of a barrel bent both ways, so the cards at its edges turn toward the camera.
 */
function onWall(gx: number, gy: number, k: number) {
  if (k < 1e-4) return `translate3d(${gx}px, ${gy}px, 0px)`;
  const rx = RX / k;
  const ry = RY / k;
  const phi = gx / rx;
  const psi = gy / ry;
  const y = ry * Math.sin(psi);
  const z1 = ry * (1 - Math.cos(psi));
  const x = (rx - z1) * Math.sin(phi);
  const z = rx - (rx - z1) * Math.cos(phi);
  return `translate3d(${x}px, ${y}px, ${z}px) rotateY(${-phi}rad) rotateX(${psi}rad)`;
}

/** A grid on the wall. `spread` pushes the rows apart (room for the caption), `zoom` dollies the camera in. */
function WallGrid({ g, k, spread, zoom, f, pop }: { g: Grid; k: number; spread: [number, number]; zoom: number; f: number; pop: boolean }) {
  const s = g.scale;
  return (
    <AbsoluteFill style={{ perspective: P, perspectiveOrigin: '50% 50%' }}>
      <div style={{ position: 'absolute', left: '50%', top: '50%', transformStyle: 'preserve-3d', transform: `translateZ(${zoom}px)` }}>
        {g.ids.map((id, i) => {
          const col = i % 3;
          const row = Math.floor(i / 3);
          const gx = g.cols[col];
          const gy = g.rows[row] + (row === 0 ? -spread[0] : spread[1]);
          // The pop-in: from a faint, small, soft card to its place in six frames.
          const at = T.pop[i];
          const p = pop ? interpolate(f, [at, at + 6], [0, 1], { ...clamp, easing: outCubic }) : 1;
          if (pop && f < at) return null;
          const sc = interpolate(p, [0, 1], [0.62, 1]);
          return (
            <div key={id + i} style={{ position: 'absolute', left: (-CARD_W * s) / 2, top: (-CARD_H * s) / 2, width: CARD_W * s, height: CARD_H * s, transformStyle: 'preserve-3d', transform: `${onWall(gx, gy, k)} scale(${sc})`, opacity: interpolate(p, [0, 1], [0.22, 1]), filter: p < 1 ? `blur(${(1 - p) * 6}px)` : undefined }}>
              <TrendCard d={TRENDS[id]} s={s} />
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

/** A caption on the wall: dark Inter Bold, centred, with an optional green word. */
function WallCaption({ children, opacity, scale, dy, blur }: { children: React.ReactNode; opacity: number; scale: number; dy: number; blur: number }) {
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: HF.sans, fontWeight: 700, fontSize: 85, letterSpacing: '0.016em', color: H.captionInk, whiteSpace: 'nowrap', opacity, transform: `translateY(${dy - 5}px) scale(${scale})`, filter: blur > 0.05 ? `blur(${blur}px)` : undefined }}>{children}</div>
    </AbsoluteFill>
  );
}

export function Wall({ f }: { f: number }) {
  // Grid A: pops in, holds, then bends into the wall (and the rows part for the caption).
  const bend = interpolate(f, [T.bend + 2, T.bent], [0, 1], { ...clamp, easing: Easing.bezier(0.6, 0, 0.35, 1) });
  const drift = interpolate(f, [T.bent, T.whip], [0, 1], clamp);
  const settle = interpolate(f, [T.pop[5] + 6, T.bend], [0, 1], { ...clamp, easing: inOut });
  const zoomA = bend * 70 + drift * 18 - settle * 10;
  // The whip: A leaves to the left, B arrives from the right, both smeared sideways.
  const whip = interpolate(f, [T.whip, T.whipEnd], [0, 1], { ...clamp, easing: Easing.bezier(0.55, 0, 0.6, 1) });
  const flatB = interpolate(f, [T.whipEnd, T.flat], [1, 0], { ...clamp, easing: outCubic });
  const panB = interpolate(f, [T.flat, T.cutClose + 2], [0, -41], { ...clamp, extrapolateLeft: "extend" });
  const smear = f >= T.whip && f < T.whipEnd + 2 ? interpolate(f, [T.whip, T.whip + 3, T.whipEnd - 1, T.whipEnd + 1], [10, 90, 70, 0], clamp) : 0;
  const shiftA = -whip * 2300;
  const shiftB = (1 - whip) * 2300;
  // Captions: the first grows in as the wall bends, then hands over to "Now Tradeable".
  const c1 = interpolate(f, [T.bend + 2, T.bent], [0, 1], { ...clamp, easing: inOut });
  const out1 = interpolate(f, [T.swap, T.swap + 3], [0, 1], clamp);
  const in2 = interpolate(f, [T.swap, T.swap + 3], [0, 1], { ...clamp, easing: outCubic });
  const showA = f < T.whipEnd;
  const showB = f >= T.whip + 2;
  const flash = interpolate(f, [T.flash, T.flashPeak, T.flashEnd], [0, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: H.purple, overflow: 'hidden' }}>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <filter id="whip" x="-50%" y="-10%" width="200%" height="120%">
          <feGaussianBlur stdDeviation={`${smear} 0`} />
        </filter>
      </svg>
      {showA ? (
        <AbsoluteFill style={{ transform: `translateX(${shiftA}px)`, filter: smear > 0.5 ? 'url(#whip)' : undefined }}>
          <WallGrid g={GRID_A} k={bend} spread={[bend * 66, bend * 88]} zoom={zoomA} f={f} pop />
          {f >= T.bend + 2 && f < T.swap + 3 ? <WallCaption opacity={c1 * (1 - out1)} scale={interpolate(c1, [0, 1], [0.42, 1])} dy={-out1 * 34} blur={(1 - c1) * 6}>Topics the world is talking about.</WallCaption> : null}
          {f >= T.swap ? (
            <WallCaption opacity={in2} scale={1} dy={(1 - in2) * 34} blur={0}>
              Now <span style={{ color: H.green }}>Tradeable</span>
            </WallCaption>
          ) : null}
        </AbsoluteFill>
      ) : null}
      {showB ? (
        <AbsoluteFill style={{ transform: `translateX(${shiftB + panB}px)`, filter: smear > 0.5 ? 'url(#whip)' : undefined }}>
          <WallGrid g={GRID_B} k={flatB} spread={[flatB * 66, flatB * 88]} zoom={flatB * 150} f={f} pop={false} />
        </AbsoluteFill>
      ) : null}
      {flash > 0 ? <AbsoluteFill style={{ background: '#fff', opacity: flash }} /> : null}
    </AbsoluteFill>
  );
}
