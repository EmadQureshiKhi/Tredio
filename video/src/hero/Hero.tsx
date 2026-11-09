// The website's hero film (landing-page/public/assets/video/hero-vid.mp4): Tredio's cut of the owner's
// source film, cut for cut on its own soundtrack. Brand-neutral footage is kept as it is; the card
// scenes, the partner panel and the end cards are made here. scripts/hero.mjs renders only the rebuilt
// frames and splices them into the source's untouched frames, so the source plays here only as a preview.
import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';

import { Detected, Panel, Sweeps } from './Closing';
import { End } from './End';
import { loadHeroFonts } from './fonts';
import { H } from './look';
import { CardPlane, planeShot } from './Plane';
import { CARDS, END, KEEP, T, cutFlash } from './timing';
import { Wall } from './Wall';

loadHeroFonts();

/** The source film, copied (never committed) to public/source/hero-src.mp4. */
export const SOURCE = 'source/hero-src.mp4';

function Rebuilt({ f }: { f: number }) {
  if (f >= END.from) return <End f={f} />;
  // The flash cuts between shots: half white, white, then the next shot under two thirds and one third.
  const white = Math.max(cutFlash(f, T.cutClose), cutFlash(f, T.cutPlane), cutFlash(f, T.cutNear), cutFlash(f, T.cutDark));
  // The closing shot: the plane softens and darkens, the captions and the panel sit on it.
  const dark = f >= T.cutDark + 2;
  return (
    <AbsoluteFill>
      {f < T.cutClose + 2 ? <Wall f={f} /> : <CardPlane shot={planeShot(f)} blur={dark ? 7 : 0} dim={dark ? 0.6 : 0} />}
      {dark && f < T.panel + 5 ? <Detected f={f} /> : null}
      {f >= T.panel ? <Panel f={f} /> : null}
      <Sweeps f={f} />
      {white > 0 ? <AbsoluteFill style={{ background: '#fff', opacity: white }} /> : null}
    </AbsoluteFill>
  );
}

export function Hero({ preview = true }: { preview?: boolean }) {
  const f = useCurrentFrame();
  const kept = KEEP.find((k) => f >= k.from && f < k.to);
  const rebuilt = (f >= CARDS.from && f < CARDS.to) || f >= END.from;
  return (
    <AbsoluteFill style={{ background: H.ink }}>
      {preview
        ? KEEP.map((k) => (
            <Sequence key={k.from} from={k.from} durationInFrames={k.to - k.from} layout="none">
              <OffthreadVideo src={staticFile(SOURCE)} trimBefore={k.from} muted style={{ width: '100%', height: '100%' }} />
            </Sequence>
          ))
        : null}
      {rebuilt && !kept ? <Rebuilt f={f} /> : null}
    </AbsoluteFill>
  );
}
