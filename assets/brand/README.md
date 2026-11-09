# Tredio brand

The logo is a brush-stroke T: a crossbar with a waving top edge and a stem that tapers to a foot.
The wordmark is TREDIO in capitals: that T, then REDIO outlined from Arial Bold at the T's cap height with the font's own spacing, on one base line.
The lockup is the wordmark with the T in the glyph colour; the glyph alone is the T.
`tools/make_brand_marks.py` draws every SVG here (and the path data the apps draw inline), so the marks never drift apart.

## Colours

| Name | Hex | Use |
| --- | --- | --- |
| Lavender | `#A49BF0` | Glyph on dark backgrounds (the app's dark `--primary`) |
| Indigo | `#5B4FD6` | Glyph on light backgrounds (the app's light `--primary`) |
| Ink | `#09090B` | Dark background, icon tiles |
| Paper | `#FAFAFA` | Wordmark on dark |
| Lime | `#E0FF98` | Accent: live states, trend coins |

## Type

Hanken Grotesk (Light 300 for text, Medium 500 for emphasis) and Newsreader (Light, display optical size) for headlines.
Both are under the SIL Open Font License 1.1; the licences sit beside the font files in `frontend/app/fonts/` and `frontend/src/features/share/fonts/`.

## Files

- `glyph-*.svg`, `wordmark-*.svg`, `lockup-*.svg`: `on-dark` and `on-light` in colour (`wordmark-*` is one colour, `lockup-*` has the T in lavender or indigo), plus `white` and `black` single-colour versions.
- `app-icon.svg` (rounded tile), `app-icon-maskable.svg` (full bleed, glyph inside the 80% safe circle), `app-icon-ios.svg` (full bleed for iOS), `favicon-tile.svg` (small sizes) and `favicon.svg` (glyph only, indigo or lavender by the browser's colour scheme).
- `visuals/studio.html`: link cards, the X banner and the website's example market scenes, one per URL hash; every number in them is illustrative.
- `export/`: the rendered PNG and ICO files.

Keep clear space around the logo of at least the T's crossbar height, and do not recolour the glyph outside the colours above.

## Export

After changing the marks, run `tools/.venv/bin/python -I tools/make_brand_marks.py` (it needs fontTools and macOS's Arial Bold) and paste the path data it prints into `frontend/src/components/shell/Logo.tsx`, `admin/src/components/Header.tsx` and `landing-page/src/components/brand/Logo.jsx`.
`assets/brand/export.sh icons` writes the favicons, PWA and touch icons and logos into `frontend/public`, `admin/public` and `landing-page`.
`assets/brand/export.sh scenes` renders the scenes with Google Chrome and writes the link cards, the X banner and the example market pictures.
It needs `rsvg-convert`, ImageMagick, `cwebp`, `sips` (macOS) and Google Chrome.
The 1500 x 500 X banner is `export/x-banner.png`.
