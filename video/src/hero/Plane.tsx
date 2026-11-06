// The card plane (frames 1377 to 2249): a large grid of trend cards with the caption "any token everyone's
// talking about. trade it!" printed in a gutter, seen by four cameras cut on flashes: a close-up that pans
// and starts to tilt, a wide tilted view, a closer sweep along the rows, and the plane blurred and darkened
// under the closing captions and the "Powered by" panel.
// The two tilted shots are corner-pinned: one card's four corners were measured in the source film at the
// start and end of each shot, and the plane is mapped through the homography those corners define.
import React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';

import { CARD_H, CARD_W, TRENDS, TrendCard } from './Card';
import { H, HF } from './look';
import { T } from './timing';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

type Layout = { gapX: number; gapY: number; gutter: number; shift: Record<number, number>; caption: { left: number; size: number; spacing: number } };

/** The close-up's grid: rows aligned, a 158 px gutter for the caption. */
const CLOSE: Layout = { gapX: 36, gapY: 28, gutter: 158, shift: {}, caption: { left: -618, size: 47.5, spacing: 0.022 } };
/** The tilted shots' grid (measured on the rectified source): rows 0 and 1 are offset, the caption is smaller. */
const TILTED: Layout = { gapX: 35, gapY: 29, gutter: 139, shift: { [-4]: 137, 0: -134, 1: 137, 2: -2, 3: -134 }, caption: { left: -544, size: 38.4, spacing: 0.022 } };

const COLS = [-4, -3, -2, -1, 0, 1, 2, 3];
const ROWS = [-4, -3, -2, -1, 0, 1, 2, 3];
// Spread so neighbours differ, with the tokens where the source had its tokens (HYPE at the centre of the close-up).
const ORDER = ['stables', 'worldCup', 'btc', 'hype', 'film', 'agents', 'heatwave', 'eth', 'mars', 'chips', 'near', 'rates'];
const pick = (c: number, r: number) => ORDER[(((5 * c + 3 * r + 6) % 12) + 12) % 12];
const rowTop = (L: Layout, r: number) => (r >= 0 ? L.gutter / 2 + r * (CARD_H + L.gapY) : -L.gutter / 2 - CARD_H - (-r - 1) * (CARD_H + L.gapY));
const colLeft = (L: Layout, c: number, r: number) => -CARD_W / 2 + c * (CARD_W + L.gapX) + (L.shift[r] ?? 0);
/** The rectangle of card (c, r) as [left, top, right, bottom]. */
const cardRect = (L: Layout, c: number, r: number) => [colLeft(L, c, r), rowTop(L, r), colLeft(L, c, r) + CARD_W, rowTop(L, r) + CARD_H] as const;

type Pt = [number, number];
type Quad = [Pt, Pt, Pt, Pt];

/** The 3 x 3 homography taking `src` to `dst` (four point pairs), row-major, h[8] = 1. */
function homography(src: Quad, dst: Quad) {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j < 9; j++) A[r][j] -= k * A[c][j];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}

/** Corners measured in the source film (TL, TR, BR, BL of one card) at two frames of a shot. */
type Pin = { card: [number, number]; from: number; to: number; a: Quad; b: Quad };
const WIDE: Pin = { card: [0, -1], from: T.cutPlane + 2, to: T.cutNear + 1, a: [[872.3, 154.9], [1443, 3.6], [1388.3, 294], [784.9, 426.4]], b: [[777.1, 146], [1355.6, -12.8], [1292.3, 290.4], [680.4, 427.6]] };
const SWEEP: Pin = { card: [-1, -1], from: 1730, to: 2030, a: [[1051.5, 721.5], [1825.1, 448.8], [1819.5, 782.3], [1112.4, 1044.6]], b: [[596.7, 583.2], [1388.9, 315.6], [1419.2, 660.4], [697, 917.4]] };
const DARK: Pin = { card: [0, -2], from: 2042, to: 2150, a: [[975.9, 196.5], [1350.4, 112.5], [1318.9, 376.3], [935.3, 434.4]], b: [[955, 204.6], [1325.1, 120.6], [1301.4, 382], [918.7, 440.8]] };

function pinned(pin: Pin, f: number) {
  // The corners move linearly through the shot (they do in the source), extrapolated to its first and last frames.
  const k = (f - pin.from) / (pin.to - pin.from);
  const dst = pin.a.map((p, i) => [p[0] + (pin.b[i][0] - p[0]) * k, p[1] + (pin.b[i][1] - p[1]) * k]) as Quad;
  const [l, t, r, b] = cardRect(TILTED, ...pin.card);
  return homography([[l, t], [r, t], [r, b], [l, b]], dst);
}

export type Shot = { layout: Layout; S: number; transform: string; perspective?: number };

/** Each shot's layout and camera at frame `f`. */
export function planeShot(f: number): Shot {
  if (f < T.cutPlane + 2) {
    // The close-up: a slow pan right along the caption while the bottom of the plane swings toward the camera.
    const S = 1.71;
    const ax = interpolate(f, [T.cutClose + 2, 1440, 1500, T.cutPlane + 2], [6, 8.8, 10, 10.5], clamp);
    const lx = interpolate(f, [T.cutClose + 2, 1410, T.cutPlane + 2], [-262, -236, -114], clamp);
    return { layout: CLOSE, S, perspective: 1000, transform: `translate(960px, 540px) rotateX(${ax}deg) translate(${-lx * S}px, ${172 * S}px)` };
  }
  // The tilted shots and the dark closing shot, corner-pinned. Cards are drawn at S times their size, so
  // the plane's own units are scaled back by 1 / S.
  const h = pinned(f < T.cutNear + 2 ? WIDE : f < T.cutDark + 2 ? SWEEP : DARK, f);
  const S = 1.5;
  const m = [h[0] / S, h[3] / S, 0, h[6] / S, h[1] / S, h[4] / S, 0, h[7] / S, 0, 0, 1, 0, h[2], h[5], 0, h[8]];
  return { layout: TILTED, S, transform: `matrix3d(${m.join(',')})` };
}

export function CardPlane({ shot, blur = 0, dim = 0 }: { shot: Shot; blur?: number; dim?: number }) {
  const { layout: L, S } = shot;
  return (
    <AbsoluteFill style={{ background: H.purple, overflow: 'hidden' }}>
      <AbsoluteFill style={{ perspective: shot.perspective, perspectiveOrigin: '960px 540px', filter: blur > 0.05 ? `blur(${blur}px)` : undefined }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, transformOrigin: '0 0', transformStyle: shot.perspective ? 'preserve-3d' : undefined, transform: shot.transform }}>
          {ROWS.flatMap((r) =>
            COLS.map((c) => {
              const [x, y] = cardRect(L, c, r);
              return <TrendCard key={`${c}:${r}`} d={TRENDS[pick(c, r)]} s={S} style={{ left: x * S, top: y * S }} />;
            }),
          )}
          <div style={{ position: 'absolute', left: L.caption.left * S, top: (-L.gutter / 2 + 44) * S, transform: 'translateY(-50%) skewX(-9deg)', transformOrigin: '0 50%', fontFamily: HF.sans, fontWeight: 700, fontSize: L.caption.size * S, letterSpacing: `${L.caption.spacing}em`, color: H.white, whiteSpace: 'nowrap', lineHeight: 1 }}>
            any token everyone's talking about. trade it!
          </div>
        </div>
      </AbsoluteFill>
      {dim > 0 ? <AbsoluteFill style={{ background: H.ink, opacity: dim }} /> : null}
    </AbsoluteFill>
  );
}
