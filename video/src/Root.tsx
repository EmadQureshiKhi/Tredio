import { Composition, Still } from 'remotion';

import { Film } from './Film';
import { loadFonts } from './fonts';
import { Hero } from './hero/Hero';
import { FPS, FRAMES } from './hero/timing';
import timeline from './timeline.json';

loadFonts();

// One film, two cuts: landscape for X's timeline and a 4:5 vertical cut for phones.
// Every scene lays itself out from the composition's size (kit.tsx useFormat).
export function Root() {
  return (
    <>
      <Composition id="Film" component={Film} durationInFrames={timeline.frames} fps={timeline.fps} width={1920} height={1080} defaultProps={{ mute: false }} />
      <Composition id="Vertical" component={Film} durationInFrames={timeline.frames} fps={timeline.fps} width={1080} height={1350} defaultProps={{ mute: false }} />
      <Still id="Poster" component={() => <Film mute poster />} width={1920} height={1080} />
      <Still id="PosterVertical" component={() => <Film mute poster />} width={1080} height={1350} />
      {/* The website's hero film: Tredio's cut of the owner's source film (src/hero, rendered by scripts/hero.mjs). */}
      <Composition id="Hero" component={Hero} durationInFrames={FRAMES} fps={FPS} width={1920} height={1080} defaultProps={{ preview: true }} />
    </>
  );
}
