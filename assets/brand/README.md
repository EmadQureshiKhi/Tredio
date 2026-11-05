# Tredio brand

The logo is an eye that is also a T: a lens for the crossbar, a pupil cut through it, and a stem below.
It stands for attention, the thing Tredio measures and trades.
The wordmark is "tredio" in lowercase, outlined from Hanken Grotesk SemiBold with tracking of -20/1000.
In the lockup the glyph is 1.12 times the wordmark's ascender height, centred on it, with a gap of a third of the glyph's width.

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

- `glyph-*.svg`, `wordmark-*.svg`, `lockup-*.svg`: `on-dark` and `on-light` in colour, plus `white` and `black` single-colour versions.
- `app-icon.svg` (rounded tile), `app-icon-maskable.svg` (full bleed, glyph inside the 80% safe circle), `app-icon-ios.svg` (full bleed for iOS), `favicon-tile.svg` (small sizes) and `favicon.svg` (glyph only, indigo or lavender by the browser's colour scheme).
- `visuals/studio.html`: link cards, the X banner, the hero poster and the website's UI scenes, one per URL hash; every number in them is illustrative.
- `export/`: the rendered PNG and ICO files.

Keep clear space around the logo of at least the pupil's diameter, and do not recolour the glyph outside the colours above.

## Export

`assets/brand/export.sh icons` writes the favicons, PWA and touch icons and logos into `frontend/public`, `admin/public` and `landing-page`.
`assets/brand/export.sh scenes` renders the scenes with Google Chrome and writes the link cards, the hero poster and the website's pictures.
It needs `rsvg-convert`, ImageMagick, `cwebp`, `sips` (macOS) and Google Chrome.
The 1500 x 500 X banner is `export/x-banner.png`.
