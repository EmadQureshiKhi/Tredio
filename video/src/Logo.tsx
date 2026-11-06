// Tredio's mark, from assets/brand: an eye that is also a T (a lens, a pupil cut through it, a stem).
// The glyph is drawn here from the brand SVG's own paths so it can open like an eye; the wordmark is
// the brand lockup file itself (public/brand/lockup-on-dark.svg), revealed left to right.
import React from 'react';
import { Img, interpolate, staticFile } from 'remotion';

import { C } from './brand';
import { clamp, t } from './kit';

const LOCKUP_W = 372.3;
const LOCKUP_H = 78.06;
/** Where the wordmark starts in the lockup (its "t" crossbar), as a share of the width. */
const WORD_X = 112 / LOCKUP_W;

/** The glyph's geometry in the lockup's viewBox (assets/brand/lockup-on-dark.svg). */
function GlyphPaths({ f, at, id, color = C.primary }: { f: number; at: number; id: string; color?: string }) {
  const open = at < 0 ? 1 : t(f, at, 22);
  const pupil = at < 0 ? 1 : t(f, at + 10, 20);
  const stem = at < 0 ? 1 : t(f, at + 16, 22);
  return (
    <>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="-10" y="-30" width="120" height="120">
          <rect x="-10" y="-30" width="120" height="120" fill="#fff" />
          <circle cx="45.04" cy="21.02" r={9.38 * pupil} fill="#000" />
        </mask>
      </defs>
      <g style={{ transform: `scaleY(${interpolate(open, [0, 1], [0.04, 1])})`, transformOrigin: '45.04px 21.02px' }}>
        <path fill={color} mask={`url(#${id})`} d="M0 21.02Q45.04 -21.02 90.07 21.02Q45.04 63.05 0 21.02Z" />
      </g>
      <g style={{ transform: `translateY(${(1 - stem) * -22}px)`, opacity: stem }}>
        <path fill={color} d="M36.03 39.03H54.04V69.06A9.01 9.01 0 0 1 36.03 69.06Z" />
      </g>
    </>
  );
}

/** The glyph alone, `size` px wide. `at` < 0 shows it settled. */
export function Glyph({ f, at, size, glow = true }: { f: number; at: number; size: number; glow?: boolean }) {
  const h = (size * 78.06) / 90.07;
  return (
    <svg width={size} height={h} viewBox="0 0 90.07 78.06" style={{ overflow: 'visible', filter: glow ? `drop-shadow(0 0 ${size * 0.12}px rgba(164,155,240,0.45))` : undefined }}>
      <GlyphPaths f={f} at={at} id={`glyph-${size}`} />
    </svg>
  );
}

/** The full lockup, `height` px tall: the glyph opens at `at`, the wordmark wipes in from `wordAt`. */
export function Lockup({ f, at, wordAt, height }: { f: number; at: number; wordAt: number; height: number }) {
  const w = (height * LOCKUP_W) / LOCKUP_H;
  const wipe = wordAt < 0 ? 1 : t(f, wordAt, 26);
  const shown = WORD_X * 100 + (1 - WORD_X) * 100 * wipe;
  return (
    <div style={{ position: 'relative', width: w, height }}>
      <Img src={staticFile('brand/lockup-on-dark.svg')} style={{ position: 'absolute', inset: 0, width: w, height, clipPath: `inset(0 ${100 - shown}% 0 ${WORD_X * 100}%)`, transform: `translateX(${(1 - wipe) * -height * 0.2}px)`, opacity: interpolate(wipe, [0, 0.2], [0, 1], clamp) }} />
      <svg width={w} height={height} viewBox={`0 0 ${LOCKUP_W} ${LOCKUP_H}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <GlyphPaths f={f} at={at} id={`lockup-${height}`} />
      </svg>
    </div>
  );
}
