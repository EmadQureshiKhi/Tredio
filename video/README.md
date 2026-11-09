# Tredio launch film

A 48 second product film for X, built as code with [Remotion](https://www.remotion.dev) from real captures of the app.
It renders two cuts from one timeline: landscape 1920x1080 and vertical 1080x1350, both 60 fps with a synthesized soundtrack at 144 BPM.

Everything on screen is either a real capture of the app on NEAR testnet (taken signed out) or kinetic type whose claims come from the repository's README.
Colours are the app's dark tokens, the faces are the app's own Hanken Grotesk and Newsreader (SIL OFL 1.1, licences in `public/fonts/`), and the logo is drawn from `assets/brand`.
No partner or third-party logos appear in the film.

## Setup

This folder is a standalone npm project, kept out of the pnpm workspace so it never touches the root lockfile.

```bash
cd video
npm install
```

Remotion downloads its own Chrome Headless Shell the first time it renders.

## Recapture

The captures in `public/captures/` are committed (about 3 MB), so a render needs nothing running.
To refresh them, start the app against testnet (it serves on port 3010 here) and run:

```bash
npm run capture                         # every page in capture.config.json
node scripts/capture.mjs http://localhost:3010 perp   # only the page load that holds this shot
```

`scripts/capture.mjs` drives Google Chrome headless at a 1600x900 viewport and device scale 2, never signs in, and spaces page loads by 20 seconds because the app reads public NEAR RPCs that rate-limit per IP.
It also writes `public/captures/boxes.json` with the CSS-pixel box of every `data-testid` element, heading, segmented option and chart, which is where the film's rings and cursor coordinates come from.
If a layout changes, check the rings in `src/Film.tsx` against the new boxes.
`internal/scrub.sh` also reads PNG bytes, so a fresh capture can trip it on a random string; re-encode that file losslessly (`ffmpeg -i in.png -pred mixed -compression_level 9 out.png`) and run it again.

## Preview

```bash
npm run studio                          # Remotion Studio: scrub both cuts
npm run stills                          # landscape contact sheet: out/stills/Film-sheet.png
node scripts/stills.mjs Vertical        # vertical contact sheet
node scripts/stills.mjs Film 600 1450   # exactly these frames
```

## Render

```bash
npm run music                           # public/audio/track.wav from src/timeline.json
npm run render                          # both cuts
npm run render:landscape                # out/tredio-launch-1920x1080.mp4
npm run render:vertical                 # out/tredio-launch-1080x1350.mp4
```

The picture renders muted and the WAV is muxed in afterwards, and the script fails if the audio is off the picture by even one sample.
A render takes three to four minutes per cut on an Apple Silicon laptop (about 7 minutes for both).

## How it is built

- `src/timeline.json`: tempo, scenes on bar lines with an energy each, and the hits, clicks, typing ticks and risers that both the picture and the music read.
- `src/Film.tsx`: one component per scene; each lays itself out for both cuts through `useFormat()`.
- `src/kit.tsx`: the motion kit (type entrances, captions, the camera on a capture, focus rings, the cursor).
- `src/Logo.tsx`: the brush T brushed on (crossbar, then stem) and the lockup's lettering wiping in from under it, drawn from copies of `assets/brand/glyph-on-dark.svg` and `lockup-on-dark.svg` in `public/brand`.
- `scripts/music.mjs` and `scripts/synth.mjs`: the offline synthesizer and master (-1 dBTP, deterministic for a given seed).

## The website's hero film

`src/hero` edits the owner's 55 second source film into Tredio's hero film, cut for cut on its own soundtrack, into `landing-page/public/assets/video/hero-vid.mp4` and its poster `hero-poster.webp`.
The source film is not in this repository: copy it to `public/source/hero-src.mp4`, which is gitignored.
Brand-neutral shots (frames 0 to 1029 and 2250 to 2419) are the source's own frames.
The card scenes, the "Powered by" panel and the end cards are made here, with every cut, flash, caption and camera move read off the source frame by frame (`src/hero/timing.ts` and the measured tracks beside each scene).
The tilted card shots are corner-pinned: the corners of one card, measured in the source, define the homography the plane is drawn through (`src/hero/Plane.tsx`).

```bash
node scripts/hero.mjs compare 1130 1800   # the source and the rebuild side by side: out/hero/compare-<frame>.png
node scripts/hero.mjs render              # render, splice, encode, check, then copy the film and poster to the website
node scripts/hero.mjs sheet               # one frame a second of the result: out/hero/sheet.png
```

Only the rebuilt frames are rendered; the kept frames are spliced in without a colour round trip and the source's AAC stream is copied bit for bit.
The render fails if the soundtrack differs from the source's, if a cut lands on a different frame, or if the marks and logos in `public/brand` and `public/logos` differ from `assets/brand` and `landing-page/public/assets/logos`.
The source was encoded with BT.709 but carries no colour tags; the rebuild is converted with BT.709 and the output is tagged.
Its faces are Inter 4 and Geist Mono (SIL OFL 1.1, licences in `public/fonts/`), and its partner logos are the website's own files, unmodified.
A render takes about 15 minutes on an Apple Silicon laptop.

