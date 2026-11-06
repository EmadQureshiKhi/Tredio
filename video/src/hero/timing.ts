// Frame numbers of the hero film at 60 fps, read off the source film frame by frame. The soundtrack is
// the source's own, so every cut, flash and title lands on the frame it did there. Keep them.

export const FPS = 60;
export const FRAMES = 3300;

/** Kept source footage: titles, charts and the purple wipe (0 to 1029), then "Automated Attention Markets". */
export const KEEP = [
  { from: 0, to: 1030 },
  { from: 2250, to: 2420 },
];
/** Rebuilt here. */
export const CARDS = { from: 1030, to: 2250 };
export const END = { from: 2420, to: 3300 };

export const T = {
  /** Each topic card of the first grid pops in. */
  pop: [1030, 1035, 1040, 1045, 1051, 1057],
  /** The grid bends into a wall while "Topics the world is talking about." grows in. */
  bend: 1088,
  bent: 1098,
  /** "Now Tradeable" replaces it. */
  swap: 1161,
  /** Whip pan to the token grid, which then flattens. */
  whip: 1266,
  whipEnd: 1272,
  flat: 1296,
  /** A white flash on the beat, peaking here. */
  flash: 1356,
  flashPeak: 1361,
  flashEnd: 1370,
  /** Flash cuts: a frame at half white, a white frame, then the next shot at 2/3 and 1/3 white. */
  cutClose: 1375,
  cutPlane: 1585,
  cutNear: 1721,
  cutDark: 2037,
  /** "Detected automatically." lands. */
  detected: 2083,
  /** The "Powered by" panel crossfades in, then its data row. */
  panel: 2153,
  dataRow: 2165,
  /** A dark band sweeps across, then a dark wedge takes the frame to black. */
  band: 2207,
  bandEnd: 2219,
  wedge: 2241,
  black: 2249,
  /** The end cards. */
  builtFor: 2420,
  near: 2463,
  glyph: 2703,
  slide: 2735,
  reveal: 2752,
  word: 2852,
  tagline: 2914,
  coming: 3186,
};

/** The white of a flash cut that peaks at frame `at + 1` and hands over to the next shot at `at + 2`. */
export function cutFlash(f: number, at: number) {
  const k = f - at;
  return k === 0 ? 0.5 : k === 1 ? 1 : k === 2 ? 2 / 3 : k === 3 ? 1 / 3 : 0;
}
