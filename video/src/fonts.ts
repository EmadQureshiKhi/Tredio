import { continueRender, delayRender, staticFile } from 'remotion';

import { FONT } from './brand';

// The app's own faces, copied from frontend/app/fonts (SIL OFL 1.1, licences beside them), served
// from public/fonts so renders are offline and exact.
const FACES: [family: string, file: string, weight: string][] = [
  [FONT.display, 'fonts/newsreader-display-light.woff2', '300'],
  [FONT.body, 'fonts/hanken-grotesk-light.woff2', '300'],
  [FONT.strong, 'fonts/hanken-grotesk-medium.woff2', '500'],
];

let loaded: Promise<void> | null = null;

export function loadFonts() {
  if (loaded) return loaded;
  const handle = delayRender('fonts');
  loaded = Promise.all(
    FACES.map(async ([family, file, weight]) => {
      const face = new FontFace(family, `url(${staticFile(file)}) format('woff2')`, { weight, style: 'normal' });
      await face.load();
      document.fonts.add(face);
    }),
  ).then(() => continueRender(handle));
  return loaded;
}
