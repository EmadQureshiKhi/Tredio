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
- `src/Logo.tsx`: the glyph opening like an eye and the lockup's wordmark wiping in.
- `scripts/music.mjs` and `scripts/synth.mjs`: the offline synthesizer and master (-1 dBTP, deterministic for a given seed).
