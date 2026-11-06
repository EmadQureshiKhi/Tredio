// Everything Tredio specific lives here. Colours come from frontend/app/globals.css (dark set) and
// assets/brand/README.md; the faces are the app's own (frontend/app/fonts, SIL OFL 1.1).
// Every claim in the film comes from README.md; keep it that way.

export const BRAND = {
  name: 'Tredio',
  tagline: "Trade the world's attention on NEAR.",
  url: 'app.tredio.bid',
};

// The app's dark tokens.
export const C = {
  bg: '#09090b',
  surface: '#111113',
  surface2: '#18181b',
  surface3: '#222226',
  line: 'rgba(255, 255, 255, 0.08)',
  lineStrong: 'rgba(255, 255, 255, 0.14)',
  text: '#fafafa',
  text2: 'rgba(250, 250, 250, 0.62)',
  text3: 'rgba(250, 250, 250, 0.4)',
  primary: '#a49bf0',
  primaryStrong: '#c0b9f6',
  primarySoft: 'rgba(164, 155, 240, 0.14)',
  onPrimary: '#0b0a14',
  accent: '#e0ff98',
  accentSoft: 'rgba(224, 255, 152, 0.12)',
  onAccent: '#0f1404',
  up: '#34d399',
  down: '#f87171',
  warn: '#fbbf24',
};

// Family names registered by fonts.ts.
export const FONT = {
  /** Newsreader Light at its display optical size: the app's headline face. */
  display: 'Newsreader Display',
  /** Hanken Grotesk Light 300: body text. */
  body: 'Hanken Grotesk',
  /** Hanken Grotesk Medium 500: labels and emphasis (a family of its own, as in the app). */
  strong: 'Hanken Grotesk Strong',
  /** The app shows identifiers in the system monospace (its --font-mono). */
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
