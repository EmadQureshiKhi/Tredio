"""Tredio's logo files: the brush T glyph and the TREDIO wordmark, written to assets/brand/ (and the website's hero word).

    tools/.venv/bin/python -I tools/make_brand_marks.py

The venv needs fontTools (`tools/.venv/bin/pip install fonttools`). Then run
`assets/brand/export.sh icons` to render the PNG, ICO and app copies from these SVGs.

- The T is the brush-stroke T, kept exactly as drawn; it is the glyph on its own and the first letter of the wordmark.
- "REDIO" is outlined from Arial Bold at the T's cap height with the font's own spacing, so the wordmark reads as one word.
- It prints the path data that the app, the admin panel and the website draw inline, and the footer band's
  letters spread across a 1856 x 304 box (`WIDE_*`), for landing-page/src/components/brand/Logo.jsx.
"""

import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/brand"
FONT = Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")

# The brush T, in its own drawing units: the crossbar's top edge waves, the stem tapers to a foot at y = 720.
T_PATH = (
    "M0 12.565C237.538 72.7035 447.069 -46.24 589.006 21.6685V157.838H381.719L348.219 720.013H149"
    "C149 720.013 125.5 278.338 315 157.838H0C0 157.606 0 59.0581 0 12.565Z"
)
CAP_TOP, BASE_LINE = 21.6558, 720.0  # the letters' cap height in the T's units
T_GAP = 111  # from the T's right edge to the R, as in the original lockup

INK, PAPER = "#09090B", "#FAFAFA"
INDIGO, LAVENDER = "#5B4FD6", "#A49BF0"


def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def path_bounds(d):
    pen = BoundsPen(None)
    parse_path(d, pen)
    return pen.bounds


def transformed(d, scale, dx, dy):
    """The path d scaled about the origin, then moved by (dx, dy), as SVG path data."""
    out = SVGPathPen(None, ntos=fmt)
    parse_path(d, TransformPen(out, (scale, 0, 0, scale, dx, dy)))
    return out.getCommands()


def letters(text, x0, tracking=0.0):
    """Arial Bold outlines of text, cap height matched to the T, first letter's ink starting at x0."""
    font = TTFont(FONT)
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    s = (BASE_LINE - CAP_TOP) / font["OS/2"].sCapHeight
    hmtx = font["hmtx"]
    names = [cmap[ord(c)] for c in text]
    x = x0 - s * hmtx[names[0]][1]
    out = SVGPathPen(glyphs, ntos=fmt)
    ink_right = x0
    for i, name in enumerate(names):
        # Font units have y up; the SVG has y down with the base line at BASE_LINE.
        glyphs[name].draw(TransformPen(out, (s, 0, 0, -s, x, BASE_LINE)))
        bp = BoundsPen(glyphs)
        glyphs[name].draw(bp)
        ink_right = x + s * bp.bounds[2]
        x += s * hmtx[name][0] + (tracking if i < len(names) - 1 else 0)
    return out.getCommands(), ink_right


def svg(w, h, body, extra=""):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" width="{fmt(w)}" height="{fmt(h)}" '
        f'role="img" aria-label="Tredio">{extra}<title>Tredio</title>{body}</svg>\n'
    )


def main():
    if not FONT.exists():
        sys.exit(f"missing font: {FONT}")
    tx0, ty0, tx1, ty1 = path_bounds(T_PATH)
    word, right = letters("REDIO", tx1 + T_GAP)
    _, wy0, _, wy1 = path_bounds(word)  # the O overshoots the cap height and the base line
    top, bottom = min(ty0, wy0), max(ty1, wy1)
    word_w, word_h = right - tx0, bottom - top

    # Wordmark and lockup, in a box 72 units high: the T and the letters share one base line.
    k = 72 / word_h
    t_small = transformed(T_PATH, k, -tx0 * k, -top * k)
    w_small = transformed(word, k, -tx0 * k, -top * k)
    W, H = word_w * k, 72
    for name, glyph, text in (
        ("wordmark-on-dark", PAPER, PAPER),
        ("wordmark-on-light", INK, INK),
        ("lockup-on-dark", LAVENDER, PAPER),
        ("lockup-on-light", INDIGO, INK),
        ("lockup-white", "#FFFFFF", "#FFFFFF"),
        ("lockup-black", "#000000", "#000000"),
    ):
        body = f'<path fill="{glyph}" d="{t_small}"/><path fill="{text}" d="{w_small}"/>'
        (OUT / f"{name}.svg").write_text(svg(W, H, body))

    # The glyph alone, 72 units high.
    gk = 72 / (ty1 - ty0)
    g = transformed(T_PATH, gk, -tx0 * gk, -ty0 * gk)
    for name, colour in (("glyph-on-dark", LAVENDER), ("glyph-on-light", INDIGO), ("glyph-white", "#FFFFFF"), ("glyph-black", "#000000")):
        (OUT / f"{name}.svg").write_text(svg((tx1 - tx0) * gk, 72, f'<path fill="{colour}" d="{g}"/>'))

    def centred(size, height):
        """The T scaled to height and centred on its ink in a size x size square."""
        sk = height / (ty1 - ty0)
        dx = (size - (tx1 - tx0) * sk) / 2 - tx0 * sk
        dy = (size - height) / 2 - ty0 * sk
        return transformed(T_PATH, sk, dx, dy)

    # Favicons: the T on its own (indigo on light pages, lavender on dark) and on the dark tile for small sizes.
    style = f"<style>path{{fill:{INDIGO}}}@media (prefers-color-scheme:dark){{path{{fill:{LAVENDER}}}}}</style>"
    (OUT / "favicon.svg").write_text(svg(64, 64, f'<path d="{centred(64, 58)}"/>', style))
    tile = f'<rect width="64" height="64" rx="14.08" fill="{INK}"/><path fill="{LAVENDER}" d="{centred(64, 40)}"/>'
    (OUT / "favicon-tile.svg").write_text(svg(64, 64, tile))

    # App icons: the rounded tile, a full-bleed maskable one (the T inside the 80% safe circle) and a full-bleed iOS one.
    glow = (
        '<defs><radialGradient id="g" cx="50%" cy="36%" r="62%"><stop offset="0" stop-color="#A49BF0" stop-opacity=".16"/>'
        '<stop offset="1" stop-color="#A49BF0" stop-opacity="0"/></radialGradient></defs>'
    )
    for name, rx, height in (("app-icon", 229.07, 560), ("app-icon-maskable", 0, 440), ("app-icon-ios", 0, 560)):
        body = (
            f'{glow}<rect width="1024" height="1024" rx="{fmt(rx)}" fill="{INK}"/><rect width="1024" height="1024" rx="{fmt(rx)}" fill="url(#g)"/>'
            f'<path fill="{LAVENDER}" d="{centred(1024, height)}"/>'
        )
        (OUT / f"{name}.svg").write_text(svg(1024, 1024, body))

    # The footer band: the T and the letters, tracked out to fill 1856 x 304 (the band is about 6:1) with the base line at 290.
    band_w, band_h, band_base, band_cap = 1856, 304, 290, 270
    s = band_cap / (BASE_LINE - CAP_TOP)
    tracking = 0.0
    for _ in range(40):  # widen the tracking until the word spans the band, less a margin each side
        wide, right = letters("REDIO", tx1 + T_GAP + tracking, tracking)
        span = (right - tx0) * s
        tracking += (band_w - 8 - span) / s / 5.5
    dx = (band_w - (right - tx0) * s) / 2 - tx0 * s
    dy = band_base - BASE_LINE * s
    wide_d = f"{transformed(T_PATH, s, dx, dy)} {transformed(wide, s, dx, dy)}"
    # The website's hero draws the same word in sand across the bottom of the first screen.
    hero = f'<svg xmlns="http://www.w3.org/2000/svg" width="{band_w}" height="{band_h}" viewBox="0 0 {band_w} {band_h}" fill="none"><path fill="#DACEC1" d="{wide_d}"/></svg>\n'
    (ROOT / "landing-page/public/assets/svg/home-hero.svg").write_text(hero)
    # Path data for the components that draw the logo inline (the app, the admin panel and the website).
    print(f'LOCKUP_VIEWBOX = "0 0 {fmt(W)} {fmt(H)}"')
    print(f'LOCKUP_T = "{t_small}"')
    print(f'LOCKUP_WORD = "{w_small}"')
    print(f'GLYPH_VIEWBOX = "0 0 {fmt((tx1 - tx0) * gk)} 72"')
    print(f'GLYPH = "{g}"')
    print(f'WIDE_VIEWBOX = "0 0 {band_w} {band_h}"')
    print(f'WIDE_T = "{transformed(T_PATH, s, dx, dy)}"')
    print(f'WIDE_WORD = "{transformed(wide, s, dx, dy)}"')


if __name__ == "__main__":
    main()
