// The end cards (frames 2420 to 3299): "Built for NEAR", the brush T alone springing in and sliding
// right, the wordmark revealed from under it as it slides back, "Trade the World's Attention" below,
// then "Coming to NEAR MAINNET". Every motion follows the source film's, measured frame by frame
// (positions in px at 1920 x 1080); the marks are assets/brand/glyph-white.svg and lockup-white.svg.
import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile } from 'remotion';

import { H, HF } from './look';
import { T } from './timing';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** Piecewise linear through measured samples: `[frame, value]` pairs in order. */
function track(f: number, samples: [number, number][]) {
  return interpolate(f, samples.map((s) => s[0]), samples.map((s) => s[1]), clamp);
}

// The source's glyph alone is 126 x 154 px, exactly this brush T at 154 px tall.
const GLYPH_H = 154;
const GLYPH_W = (GLYPH_H * 58.9) / 72;
// In the lockup the T is 70.83 of the 72 units, so a lockup this tall carries a 154 px T.
const LOCKUP_H = (GLYPH_H * 72) / 70.83;
const LOCKUP_W = (LOCKUP_H * 361.93) / 72;
const WORD_X = 960 - LOCKUP_W / 2;
/** Where the lettering starts in the lockup (its R), in px. */
const LETTERS_X = (LOCKUP_H * 68.86) / 72;

/** The T's height while it springs in (source: 128, 160, ... settling at 154). */
const SPRING: [number, number][] = [128, 160, 176, 186, 194, 198, 198, 197, 194, 189, 184, 178, 172, 166, 162, 158, 154, 152, 150, 148, 148, 148, 148, 154].map((h, i) => [T.glyph + 4 + i, h / 154]);
/** The T's travel: 0 centred, 1 at the far right, then back to 0 at the word's start (normalised from the source's x). */
const OUT: [number, number][] = [[2730, 0], [2731, 0.005], [2732, 0.014], [2733, 0.026], [2734, 0.035], [2737, 0.115], [2740, 0.245], [2743, 0.423], [2746, 0.621], [2749, 0.794], [2752, 0.921], [2755, 1]];
const BACK: [number, number][] = [1327, 1327, 1324, 1319, 1314, 1305, 1295, 1282, 1267, 1249, 1229, 1207, 1181, 1153, 1122, 1088, 1051, 1014, 974, 934, 894, 853, 814, 777, 743, 711, 680, 654, 629, 608, 590, 573, 559, 549, 540, 532, 527, 523, 522].map((x, i) => [2755 + i * 3, (x - 522) / (1327 - 522)]);
/** The word rising for the tagline (top edge in the source, 463 at rest) and the tagline's vertical spring. */
const RISE: [number, number][] = [[2914, 463], [2915, 460], [2916, 452], [2917, 443], [2918, 434], [2919, 426], [2920, 417], [2921, 409], [2922, 405], [2923, 401], [2924, 398], [2925, 396], [2926, 395], [2927, 395], [2928, 396], [2929, 397], [2930, 399], [2931, 401], [2932, 403], [2933, 405], [2934, 407], [2935, 409], [2936, 411], [2938, 414], [2939, 415], [2944, 415], [2948, 412], [2952, 410], [2956, 409], [2970, 410], [2990, 411]];
const TAG: [number, number][] = [[2917, 0], [2919, 10 / 58], [2920, 16 / 58], [2921, 21 / 58], [2922, 26 / 58], [2923, 31 / 58], [2924, 36 / 58], [2925, 42 / 58], [2926, 47 / 58], [2927, 52 / 58], [2928, 57 / 58], [2929, 60 / 58], [2930, 62 / 58], [2931, 64 / 58], [2932, 66 / 58], [2934, 67 / 58], [2936, 66 / 58], [2938, 64 / 58], [2940, 62 / 58], [2942, 58 / 58], [2944, 56 / 58], [2946, 54 / 58], [2950, 54 / 58], [2954, 55 / 58], [2958, 57 / 58], [2966, 58 / 58]];

const TITLE: React.CSSProperties = { fontFamily: HF.sans, fontWeight: 700, color: H.white, whiteSpace: 'nowrap', lineHeight: 1 };

function BuiltFor({ f }: { f: number }) {
  // Hard cuts in, as in the source; it shrinks and fades in three frames when the T arrives.
  const out = interpolate(f, [T.glyph, T.glyph + 3], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: 1 - out, transform: `scale(${1 - out * 0.12})`, transformOrigin: '824px 538px' }}>
      <div style={{ ...TITLE, position: 'absolute', left: 580, top: 395, fontSize: 131, letterSpacing: '0.008em' }}>Built for</div>
      {f >= T.near ? <div style={{ ...TITLE, position: 'absolute', left: 580, top: 552, fontSize: 131, letterSpacing: '0.008em', color: H.accent }}>NEAR</div> : null}
    </AbsoluteFill>
  );
}

function Wordmark({ f }: { f: number }) {
  const rest = 463;
  const top = f < 2914 ? rest : track(f, RISE);
  // At the far right the T stops 73 px short of where the finished word ends, as in the source.
  const atRight = LOCKUP_W - 73;
  // x of the T's left edge, from the frame centre to the right and back to the word's start.
  const tx = f < 2730 ? 960 - GLYPH_W / 2 : f < 2755 ? interpolate(track(f, OUT), [0, 1], [960 - GLYPH_W / 2, WORD_X + atRight]) : WORD_X + atRight * track(f, BACK);
  const sy = f < T.glyph + 4 ? 128 / 154 : f < T.glyph + 4 + SPRING.length ? track(f, SPRING) : 1;
  const done = f >= 2870;
  // The lettering shows only to the right of the moving T's middle, so it slides out from under it.
  const reveal = Math.max(LETTERS_X - 4, tx - WORD_X + GLYPH_W / 2);
  const tagS = f < 2917 ? 0 : track(f, TAG);
  return (
    <AbsoluteFill>
      {done ? (
        <Img src={staticFile('brand/lockup-white.svg')} style={{ position: 'absolute', left: WORD_X, top, width: LOCKUP_W, height: LOCKUP_H }} />
      ) : (
        <>
          {f >= 2756 ? <Img src={staticFile('brand/lockup-white.svg')} style={{ position: 'absolute', left: WORD_X, top, width: LOCKUP_W, height: LOCKUP_H, clipPath: `inset(0 0 0 ${reveal}px)` }} /> : null}
          <Img src={staticFile('brand/glyph-white.svg')} style={{ position: 'absolute', left: tx, top, width: GLYPH_W, height: GLYPH_H, transform: `scaleY(${sy})`, transformOrigin: '50% 50%' }} />
        </>
      )}
      {tagS > 0 ? (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 623, display: 'flex', justifyContent: 'center', transform: `translateY(-50%) scaleY(${tagS})` }}>
          <div style={{ ...TITLE, fontSize: 80, letterSpacing: '-0.01em' }}>Trade the World’s Attention</div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

function Coming() {
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 416, textAlign: 'center', fontFamily: HF.mono, fontWeight: 400, fontSize: 53, lineHeight: 1, color: H.gold, whiteSpace: 'nowrap' }}>Coming to</div>
      <div style={{ ...TITLE, position: 'absolute', left: 0, right: 0, top: 467, textAlign: 'center', fontSize: 121, fontWeight: 700, letterSpacing: '-0.005em' }}>NEAR MAINNET</div>
    </AbsoluteFill>
  );
}

export function End({ f }: { f: number }) {
  return (
    <AbsoluteFill style={{ background: H.ink }}>
      {f < T.glyph + 3 ? <BuiltFor f={f} /> : null}
      {f >= T.glyph + 3 && f < T.coming ? <Wordmark f={f} /> : null}
      {f >= T.coming ? <Coming /> : null}
    </AbsoluteFill>
  );
}
