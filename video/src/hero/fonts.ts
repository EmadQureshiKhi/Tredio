import { continueRender, delayRender, staticFile } from 'remotion';

import { HF } from './look';

// The hero film's faces, both variable and SIL OFL 1.1 (licences beside them in public/fonts):
// Inter 4.001 matches the source film's titles; Geist Mono (the admin app's mono) stands in for its card figures.
const FACES: [family: string, file: string][] = [
  [HF.sans, 'fonts/inter-variable-latin.woff2'],
  [HF.mono, 'fonts/geist-mono-variable-latin.woff2'],
];

let loaded: Promise<void> | null = null;

export function loadHeroFonts() {
  if (loaded) return loaded;
  const handle = delayRender('hero fonts');
  loaded = Promise.all(
    FACES.map(async ([family, file]) => {
      const face = new FontFace(family, `url(${staticFile(file)}) format('woff2')`, { weight: '100 900', style: 'normal' });
      await face.load();
      document.fonts.add(face);
    }),
  ).then(() => continueRender(handle));
  return loaded;
}
