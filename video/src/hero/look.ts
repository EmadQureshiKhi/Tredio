// The hero film's look, measured from the source film's frames (decoded as BT.709, which is how it
// was encoded): its purple, its near-black with a faint green cast, its card colours and its type.
// The rebuilt scenes must cut seamlessly against the kept footage, so these are the source's values,
// not the app's tokens.

export const H = {
  /** The card scenes' backdrop. */
  purple: '#7662D0',
  /** The black of the title cards. */
  ink: '#070A07',
  /** Title white. */
  white: '#F7FAF7',
  /** The accent of "Built for ...". */
  accent: '#8278FC',
  /** "Coming to" and "Automated". */
  gold: '#FFC500',
  /** "Tradeable". */
  green: '#00DB43',
  /** Captions on the purple wall. */
  captionInk: '#050100',
  card: {
    bg: '#0E1110',
    rim: 'rgba(32, 14, 64, 0.9)',
    text: '#F2F4F2',
    dim: '#2E2D31',
    handle: '#2B2A2E',
    vol: '#D2D3D4',
    pill: '#23212C',
    pillText: '#6E6A78',
    line: '#A49BF0',
    dot: '#B9B2F6',
    base: 'rgba(255, 255, 255, 0.045)',
  },
};

export const HF = {
  /** Inter 4 (variable): the source's sans, bold for titles, medium for card names. */
  sans: 'Inter Hero',
  /** Geist Mono (variable): the card figures. */
  mono: 'Geist Mono Hero',
};
