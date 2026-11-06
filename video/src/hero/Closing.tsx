// Over the darkened plane (frames 2039 to 2249): "Every trending topic." then "Detected automatically."
// landing with a squash and stretch, the "Powered by" panel, a dark band and the dark wedge to black.
import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile } from 'remotion';

import { H, HF } from './look';
import { T } from './timing';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const outCubic = Easing.bezier(0.2, 0.7, 0.3, 1);

/** Piecewise linear through measured samples: `[frame, value]` pairs in order. */
function track(f: number, samples: [number, number][]) {
  return interpolate(f, samples.map((p) => p[0]), samples.map((p) => p[1]), clamp);
}

// Measured on the source frame by frame: the first line's cap top and scale as the second lands, and the
// second line's vertical stretch about its middle (it overshoots tall, swings short, then settles).
const EVERY_TOP: [number, number][] = [[2083, 487], [2084, 474], [2085, 461], [2086, 448], [2087, 435], [2088, 431], [2089, 427], [2090, 425], [2091, 423], [2093, 423], [2095, 425], [2097, 428], [2100, 432], [2103, 436], [2106, 438], [2112, 437]];
const EVERY_SCALE: [number, number][] = [[2083, 1], [2084, 0.95], [2085, 0.87], [2086, 0.82], [2087, 0.79], [2088, 0.774], [2089, 0.763], [2090, 0.767], [2097, 0.772], [2099, 0.774], [2100, 0.782], [2102, 0.792], [2104, 0.798], [2106, 0.802]];
const DETECTED_Y: [number, number][] = [[2083, 0.02], [2084, 0.23], [2085, 0.485], [2086, 0.737], [2087, 0.99], [2088, 1.14], [2089, 1.27], [2090, 1.35], [2091, 1.42], [2092, 1.46], [2093, 1.47], [2094, 1.46], [2095, 1.43], [2096, 1.38], [2097, 1.33], [2098, 1.26], [2099, 1.19], [2100, 1.12], [2101, 1.05], [2102, 0.99], [2103, 0.94], [2104, 0.9], [2105, 0.86], [2106, 0.84], [2107, 0.82], [2109, 0.82], [2110, 0.83], [2111, 0.85], [2112, 0.87], [2113, 0.89], [2114, 0.92], [2115, 0.95], [2116, 0.97], [2117, 0.99], [2118, 1.02], [2119, 1.03], [2120, 1.04], [2121, 1.05], [2126, 1.05], [2127, 1.03], [2129, 1.02], [2131, 1], [2133, 0.98], [2135, 0.97], [2142, 0.97], [2146, 0.99], [2147, 1]];
/** The vertical middle of the caps of "Detected automatically.", which the stretch is centred on. */
const DETECTED_MID = 571;
const EVERY_SIZE = 108.7;
const DETECTED_SIZE = 136;
/** Inter's cap height and the offset of the caps' top below a line box of line-height 1. */
const CAP = 0.727;
const CAP_TOP = 0.137;

export function Detected({ f }: { f: number }) {
  const leave = interpolate(f, [T.panel, T.panel + 4], [0, 1], clamp);
  const top = f < T.detected ? 487 : track(f, EVERY_TOP);
  const sc = f < T.detected ? 1 : track(f, EVERY_SCALE);
  const sy = f < T.detected ? 0 : track(f, DETECTED_Y);
  const line: React.CSSProperties = { position: 'absolute', left: 0, right: 0, display: 'flex', justifyContent: 'center', fontFamily: HF.sans, fontWeight: 700, color: H.white, whiteSpace: 'nowrap', lineHeight: 1 };
  return (
    <AbsoluteFill style={{ opacity: 1 - leave, transform: `translateY(${-leave * 14}px)` }}>
      {/* Scaled about its caps' middle, so the cap top lands where the source's does. */}
      <div style={{ ...line, top: top - EVERY_SIZE * CAP_TOP - (EVERY_SIZE * CAP * (1 - sc)) / 2, fontSize: EVERY_SIZE, letterSpacing: '0.028em', transform: `scale(${sc})`, transformOrigin: `50% ${EVERY_SIZE * (CAP_TOP + CAP / 2)}px` }}>Every trending topic.</div>
      {sy > 0 ? <div style={{ ...line, top: DETECTED_MID - DETECTED_SIZE * (CAP_TOP + CAP / 2), fontSize: DETECTED_SIZE, letterSpacing: '0.0205em', transform: `scaleY(${sy})`, transformOrigin: `50% ${DETECTED_SIZE * (CAP_TOP + CAP / 2)}px` }}>Detected automatically.</div> : null}
    </AbsoluteFill>
  );
}

type Partner = { name: string; src: string; ratio: number; scale?: number; withName?: boolean };

// The website's own "Built with" list (landing-page/src/config/partners.js), logo files unmodified.
const BUILT_ON: Partner[] = [
  { name: 'NEAR', src: 'logos/near.svg', ratio: 1440 / 351, scale: 0.84 },
  { name: 'NEAR Intents', src: 'logos/near-intents.svg', ratio: 1748.82 / 359.71, scale: 1.02 },
  { name: 'NEAR AI', src: 'logos/near-ai.svg', ratio: 730 / 138, scale: 0.8 },
  { name: 'OutLayer', src: 'logos/outlayer.png', ratio: 1257 / 214, scale: 0.9 },
  { name: 'Hyperliquid', src: 'logos/hyperliquid.svg', ratio: 856 / 200, scale: 1.04 },
  { name: 'Rhea Finance', src: 'logos/rhea.svg', ratio: 34 / 31, withName: true },
];
const DATA_FROM: Partner[] = [
  { name: 'Elfa', src: 'logos/elfa.svg', ratio: 76 / 26, scale: 0.8 },
  { name: 'Nansen', src: 'logos/nansen.svg', ratio: 117.98 / 47.85, scale: 1.42 },
  { name: 'CoinGecko', src: 'logos/coingecko.svg', ratio: 1000 / 219, scale: 1.04 },
  { name: 'Wikipedia', src: 'logos/wikipedia-wordmark.svg', ratio: 119 / 18, scale: 0.78 },
  { name: 'Bluesky', src: 'logos/bluesky.svg', ratio: 1148 / 252, scale: 0.86 },
];

/** Every logo gets the same optical area, as on the website. */
const LOGO_AREA = 6400;
const TILE_W = 224;
const TILE_H = 136;
const TILE_GAP = 16;

function Tile({ p, opacity, dy }: { p: Partner; opacity: number; dy: number }) {
  const w = Math.min(TILE_W - 36, Math.sqrt(LOGO_AREA * p.ratio) * (p.scale ?? 1));
  return (
    <div style={{ width: TILE_W, height: TILE_H, borderRadius: 24, background: 'rgba(12, 11, 18, 0.92)', boxShadow: 'inset 0 0 0 1.5px rgba(255, 255, 255, 0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity, transform: `translateY(${dy}px)` }}>
      {p.withName ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: HF.sans, fontWeight: 600, fontSize: 24, color: H.white, whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
          <Img src={staticFile(p.src)} style={{ height: 34, width: 34 * p.ratio }} />
          {p.name}
        </div>
      ) : (
        <Img src={staticFile(p.src)} style={{ width: w, height: w / p.ratio }} />
      )}
    </div>
  );
}

const ROW_LABEL: React.CSSProperties = { fontFamily: HF.sans, fontWeight: 600, fontSize: 19, letterSpacing: '0.2em', color: 'rgba(200, 200, 212, 0.62)', textAlign: 'center' };

export function Panel({ f }: { f: number }) {
  const inP = interpolate(f, [T.panel, T.panel + 4], [0, 1], { ...clamp, easing: outCubic });
  const data = interpolate(f, [T.dataRow, T.dataRow + 6], [0, 1], { ...clamp, easing: outCubic });
  const width = 6 * TILE_W + 5 * TILE_GAP + 120;
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', left: (1920 - width) / 2, top: 268, width, height: 544, borderRadius: 44, background: 'linear-gradient(180deg, rgba(16, 14, 24, 0.94), rgba(11, 10, 17, 0.94))', boxShadow: 'inset 0 0 0 1.5px rgba(255, 255, 255, 0.09), 0 30px 80px rgba(0, 0, 0, 0.35)', opacity: inP, transform: `scale(${interpolate(inP, [0, 1], [0.97, 1])})` }}>
        <div style={{ position: 'absolute', top: 38, left: 0, right: 0, textAlign: 'center', fontFamily: HF.sans, fontWeight: 700, fontSize: 62, letterSpacing: '-0.015em', color: H.white, lineHeight: 1 }}>Powered by</div>
        <div style={{ ...ROW_LABEL, position: 'absolute', top: 126, left: 0, right: 0 }}>BUILT ON</div>
        <div style={{ position: 'absolute', top: 160, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: TILE_GAP }}>
          {BUILT_ON.map((p) => <Tile key={p.name} p={p} opacity={1} dy={0} />)}
        </div>
        <div style={{ ...ROW_LABEL, position: 'absolute', top: 330, left: 0, right: 0, opacity: data }}>DATA FROM</div>
        <div style={{ position: 'absolute', top: 364, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: TILE_GAP }}>
          {DATA_FROM.map((p) => <Tile key={p.name} p={p} opacity={data} dy={(1 - data) * 16} />)}
        </div>
      </div>
    </AbsoluteFill>
  );
}

// The two dark sweeps, measured on the source: a band 260 px wide swinging like a spoke about a point off
// the top-left corner (frames 2207 to 2219), then the edge of a dark field swinging about a point further
// left until it has covered the frame (2241 to 2248). Angles are of the edge below the horizontal, in degrees.
const BAND_PIVOT: [number, number] = [-313, -207];
const BAND_ANGLE: [number, number][] = [[2206, 84], [2207, 78], [2208, 73], [2209, 67], [2210, 62], [2211, 57], [2212, 51.7], [2213, 45.2], [2214, 39.9], [2215, 34.3], [2216, 27.4], [2217, 20], [2218, 13], [2219, 5], [2220, -3]];
const WEDGE_PIVOT: [number, number] = [-1530, -367];
const WEDGE_ANGLE: [number, number][] = [[2240, 43.5], [2241, 39.4], [2242, 35.2], [2243, 31.1], [2244, 26], [2245, 22.5], [2246, 17.1], [2247, 14], [2248, 3]];

/** A polygon for clip-path from points in px. */
const poly = (pts: [number, number][]) => `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ')})`;

export function Sweeps({ f }: { f: number }) {
  const band = () => {
    const a = (track(f, BAND_ANGLE) * Math.PI) / 180;
    const [px, py] = BAND_PIVOT;
    const d = [Math.cos(a), Math.sin(a)];
    const n = [-Math.sin(a), Math.cos(a)];
    const at = (s: number, o: number): [number, number] => [px + d[0] * s + n[0] * o, py + d[1] * s + n[1] * o];
    return poly([at(-400, -130), at(5000, -130), at(5000, 130), at(-400, 130)]);
  };
  const wedge = () => {
    const a = (track(f, WEDGE_ANGLE) * Math.PI) / 180;
    const [px, py] = WEDGE_PIVOT;
    const far: [number, number] = [px + Math.cos(a) * 6000, py + Math.sin(a) * 6000];
    return poly([[px, py], far, [far[0], far[1] + 9000], [px - 100, py + 9000]]);
  };
  return (
    <>
      {f >= T.band && f < T.bandEnd ? <AbsoluteFill style={{ background: H.ink, clipPath: band() }} /> : null}
      {f >= T.wedge ? <AbsoluteFill style={{ background: H.ink, clipPath: wedge() }} /> : null}
    </>
  );
}
