// Tredio's mark, from assets/brand: the brush T (glyph-on-dark.svg) and the lockup, the brush T with REDIO in
// caps (lockup-on-dark.svg), both copied unmodified to public/brand. The files are drawn as they are and
// only revealed: the T's crossbar is brushed on left to right, then its stem drops in; the lettering wipes
// in from under the T.
import React from 'react';
import { Img, interpolate, staticFile } from 'remotion';

import { C } from './brand';
import { clamp, t } from './kit';

/** The glyph's viewBox. */
const GLYPH_W = 58.9;
const GLYPH_H = 72;
/** The lockup's viewBox, its T's size inside it and where its lettering starts (the R). */
const LOCKUP_W = 361.93;
const LOCKUP_H = 72;
const LOCKUP_T_W = 57.94;
const LETTERS_X = 68.86;
/** The crossbar's depth as a share of the T's height (the stem starts below it). */
const BAR = 16 / 72;

/** The T's reveal as a clip-path on a box `w` x `h`: the crossbar brushed to `bar` of its width, the stem down to `stem` of its height. */
function brush(w: number, h: number, bar: number, stem: number) {
  const bx = w * bar;
  const by = h * BAR;
  const sy = by + (h - by) * stem;
  return `polygon(0 0, ${bx}px 0, ${bx}px ${by}px, ${w}px ${by}px, ${w}px ${sy}px, 0 ${sy}px, 0 ${by}px)`;
}

function useBrush(f: number, at: number) {
  if (at < 0) return { bar: 1, stem: 1, drop: 0 };
  const bar = t(f, at, 14);
  const stem = t(f, at + 8, 16);
  return { bar, stem, drop: (1 - stem) * -0.12 };
}

/** The glyph alone, `size` px tall. `at` < 0 shows it settled. */
export function Glyph({ f, at, size, glow = true }: { f: number; at: number; size: number; glow?: boolean }) {
  const h = size;
  const w = (size * GLYPH_W) / GLYPH_H;
  const { bar, stem, drop } = useBrush(f, at);
  return (
    <div style={{ width: w, height: h, filter: glow ? `drop-shadow(0 0 ${size * 0.1}px rgba(164,155,240,0.45))` : undefined }}>
      <Img src={staticFile('brand/glyph-on-dark.svg')} style={{ width: w, height: h, display: 'block', clipPath: brush(w, h, bar, stem), transform: `translateY(${drop * h}px)` }} />
    </div>
  );
}

/** The full lockup, `height` px tall: the T is brushed on at `at`, the lettering wipes in from `wordAt`. */
export function Lockup({ f, at, wordAt, height }: { f: number; at: number; wordAt: number; height: number }) {
  const w = (height * LOCKUP_W) / LOCKUP_H;
  const tw = (height * LOCKUP_T_W) / LOCKUP_H;
  const lx = (height * LETTERS_X) / LOCKUP_H;
  const { bar, stem, drop } = useBrush(f, at);
  const wipe = wordAt < 0 ? 1 : t(f, wordAt, 26);
  const shown = lx + (w - lx) * wipe;
  const file = staticFile('brand/lockup-on-dark.svg');
  return (
    <div style={{ position: 'relative', width: w, height }}>
      {/* The lettering, clipped to the right of the T and revealed left to right as it slides in. */}
      <Img src={file} style={{ position: 'absolute', inset: 0, width: w, height, clipPath: `inset(0 ${w - shown}px 0 ${lx}px)`, transform: `translateX(${(1 - wipe) * -height * 0.2}px)`, opacity: interpolate(wipe, [0, 0.2], [0, 1], clamp) }} />
      {/* The T: the same file clipped to the T, brushed on. */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: tw, height, overflow: 'hidden', filter: `drop-shadow(0 0 ${height * 0.08}px ${C.primary}55)` }}>
        <Img src={file} style={{ position: 'absolute', left: 0, top: 0, width: w, height, clipPath: brush(tw, height, bar, stem), transform: `translateY(${drop * height}px)` }} />
      </div>
    </div>
  );
}
