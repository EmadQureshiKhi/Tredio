# Tredio films (video/)

Remotion project for the X launch film and the website's hero film (`src/hero`); see README.md for capture, preview and render commands.

- Standalone npm project on purpose: adding it to pnpm-workspace.yaml would change the root lockfile.
- Launch film: footage is real and signed out only (no testnet account is created); claims come from the root README; no partner or third-party logos until permission arrives.
- Overlay coordinates are capture CSS pixels; recapturing can move elements, so re-check rings and cursor points against `public/captures/boxes.json`.
- Launch film: every scene must work at 1920x1080 and 1080x1350 (`useFormat()` in src/kit.tsx); check both contact sheets after any change.
- `Slam` keeps its layout box before its hit, so stacked lines never jump when one lands.
- Remotion's own AAC is late; render through `scripts/render.mjs`, which renders muted and muxes the WAV.
- Hero film: a re-edit of the previous product's film, whose copy lives only in gitignored `public/source/`; never write that product's names, chain or partners into any file. Measure changes against the source with `node scripts/hero.mjs compare <frames>` and keep every cut on its frame (the soundtrack is the source's). It shows the website's partner logos, as the owner asked.

