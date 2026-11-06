"""README art for Tredio: the hero lockup (light and dark) and three diagrams.

    tools/.venv/bin/python -m tools.make_readme_art          write every image to assets/readme/
    tools/.venv/bin/python -m tools.make_readme_art --check  report what would change, write nothing

The venv needs only Pillow 12 (`python3 -m venv tools/.venv && tools/.venv/bin/pip install Pillow==12.0.0`).

Why it is built this way:

- Pillow only, and every colour that belongs to Tredio comes from the app's own design tokens
  (frontend/app/globals.css): the indigo `--primary` of the light theme for the diagrams and the
  lavender `--primary` of the dark theme for the dark hero. Nothing here re-types a brand hex, so the
  figures follow the product when it changes. Everything else is the fixed diagram palette shared
  with other projects (white page, #FAFAFB cards, #131316 text).
- The text accent is derived, not the brand hex: the nearest value of the same hue that clears 4.5:1
  on both the card and the tinted band. `audit()` runs before anything is drawn and writes nothing
  if any text colour misses AA on any surface it can land on.
- Washes are pre-blended to opaque colours, because ImageDraw overwrites alpha instead of
  compositing.
- Figures are drawn at 2x and reduced with LANCZOS to 960 px wide, the width of a README column, so
  9 pt text stays legible where it is read.
- One `flow()` pass places every line of a panel, and both measuring and drawing use it, so a panel
  can never be measured shorter than it draws. Column gutters widen to fit the widest arrow label,
  and an arrow runs at the middle of the vertical span its two panels share.
- The hero uses the real lockup (assets/brand/lockup-*.svg, rendered by assets/brand/export.sh),
  not the wordmark retyped in a system font, and centres it on its ink (alpha bbox), not its box.
- SF Pro is a variable font: weights are set on its Weight axis and the optical size follows the
  point size, as the system does. A missing font exits 2, because a substituted font invalidates
  every measurement.
"""

from __future__ import annotations

import argparse
import colorsys
import hashlib
import io
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "readme"
TOKENS = ROOT / "frontend" / "app" / "globals.css"
EXPORT = ROOT / "assets" / "brand" / "export"
MARK = EXPORT / "glyph-on-light.png"
LOCKUP = {"light": EXPORT / "lockup-on-light.png", "dark": EXPORT / "lockup-on-dark.png"}
FONT_FILES = {"sans": Path("/System/Library/Fonts/SFNS.ttf"), "mono": Path("/System/Library/Fonts/SFNSMono.ttf")}
WEIGHTS = {"regular": 400, "semibold": 590, "bold": 700}

SCALE = 2
FIGURE_WIDTH = 960
HERO_HEIGHT = 232
RADIUS_CARD = 12


def px(value: float) -> int:
    return int(round(value * SCALE))


# Colour ---------------------------------------------------------------------------------------


def parse_hex(colour: str) -> tuple[int, int, int]:
    text = colour.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"expected #RRGGBB, got {colour!r}")
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def to_hex(rgb: tuple[float, float, float]) -> str:
    return "#%02X%02X%02X" % tuple(round(c) for c in rgb)


def blend(top: str, bottom: str, alpha: float) -> str:
    """`top` at `alpha` over `bottom`, as an opaque hex colour."""
    t, b = parse_hex(top), parse_hex(bottom)
    return to_hex(tuple(t[i] * alpha + b[i] * (1 - alpha) for i in range(3)))  # type: ignore[arg-type]


def relative_luminance(colour: str) -> float:
    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in parse_hex(colour))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(foreground: str, background: str) -> float:
    a, b = relative_luminance(foreground), relative_luminance(background)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def meets_aa(foreground: str, background: str) -> bool:
    return contrast_ratio(foreground, background) >= 4.5


def readable(colour: str, *surfaces: str) -> str:
    """The nearest colour to `colour` (same hue and saturation) that clears AA on every surface.

    It searches outward in value, both directions: darkening is right on a light card and wrong on
    a dark one, where a downward-only search walks to black and then gives up unchanged.
    """
    hue, saturation, value = colorsys.rgb_to_hsv(*[c / 255 for c in parse_hex(colour)])

    def at(v: float) -> str:
        return to_hex(tuple(c * 255 for c in colorsys.hsv_to_rgb(hue, saturation, v)))  # type: ignore[arg-type]

    def passes(candidate: str) -> bool:
        return all(meets_aa(candidate, s) for s in surfaces)

    if passes(colour):
        return colour
    for step in range(1, 51):
        for direction in (-1, 1):
            v = value + direction * step * 0.02
            if 0.0 <= v <= 1.0 and passes(at(v)):
                return at(v)
    return colour


def read_tokens(selector: str) -> dict[str, str]:
    """The custom properties of one rule in the app's globals.css."""
    css = TOKENS.read_text()
    match = re.search(rf"^{re.escape(selector)}\s*\{{(.*?)^\}}", css, re.S | re.M)
    if not match:
        raise SystemExit(f"ERROR: no `{selector}` rule in {TOKENS}.")
    return dict(re.findall(r"--([\w-]+):\s*([^;]+);", match.group(1)))


def solid(value: str, over: str) -> str:
    """A token as an opaque colour: hex as is, rgba() blended over `over`."""
    value = value.strip()
    if value.startswith("#"):
        return to_hex(parse_hex(value))  # type: ignore[arg-type]
    match = re.fullmatch(r"rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)", value)
    if not match:
        raise SystemExit(f"ERROR: cannot read the colour token {value!r}.")
    r, g, b, a = match.groups()
    return blend(to_hex((int(r), int(g), int(b))), over, float(a))


@dataclass(frozen=True)
class Palette:
    name: str
    page: str
    surface: str
    surface_alt: str
    border: str
    border_strong: str
    text: str
    text_secondary: str
    text_muted: str
    accent: str  # the brand colour, decorative only: emphasis borders, bullet dots, the hero rule
    accent_text: str  # the brand colour moved until it reads at AA, for anything anyone reads
    band: str  # a 10% accent wash, pre-blended
    rule: str


def palettes() -> tuple[Palette, Palette]:
    light_tokens = read_tokens(':root[data-theme="light"]')
    dark_tokens = read_tokens(":root")
    accent = solid(light_tokens["primary"], "#FFFFFF")
    accent_dark = solid(dark_tokens["primary"], "#000000")

    light_surface = "#FAFAFB"
    light_band = blend(accent, light_surface, 0.10)
    light = Palette(
        name="light",
        page="#FFFFFF",
        surface=light_surface,
        surface_alt="#F2F2F4",
        border="#DFDFE4",
        border_strong="#B9B9C2",
        text="#131316",
        text_secondary="#43434E",
        text_muted="#5F5F6B",
        accent=accent,
        accent_text=readable(accent, light_surface, light_band),
        band=light_band,
        rule="#E4E4E9",
    )

    page = solid(dark_tokens["bg"], "#000000")
    surface = solid(dark_tokens["surface"], page)
    band = blend(accent_dark, surface, 0.10)
    dark = Palette(
        name="dark",
        page=page,
        surface=surface,
        surface_alt=solid(dark_tokens["surface-2"], page),
        border=solid(dark_tokens["line"], surface),
        border_strong=solid(dark_tokens["line-strong"], surface),
        text=solid(dark_tokens["text"], surface),
        text_secondary=readable(solid(dark_tokens["text-2"], surface), surface, band),
        text_muted=readable(solid(dark_tokens["text-3"], surface), surface, band),
        accent=accent_dark,
        accent_text=readable(accent_dark, surface, band),
        band=band,
        rule=solid(dark_tokens["line"], surface),
    )
    return light, dark


def audit(palette: Palette) -> list[str]:
    """Every text role against every surface it can land on. AA or it is a defect."""
    problems = []
    for surface_name, surface in (("card", palette.surface), ("band", palette.band)):
        for role in ("text", "text_secondary", "text_muted", "accent_text"):
            colour = getattr(palette, role)
            ratio = contrast_ratio(colour, surface)
            mark = "ok  " if ratio >= 4.5 else "FAIL"
            line = f"  {mark}  {palette.name:5} {role:15} {colour} on the {surface_name} {surface}  {ratio:5.2f}:1"
            print(line)
            if ratio < 4.5:
                problems.append(line.strip())
    return problems


# Type -----------------------------------------------------------------------------------------

_fonts: dict[tuple[str, float], ImageFont.FreeTypeFont] = {}


def font(kind: str, size: float) -> ImageFont.FreeTypeFont:
    """`kind` is regular, semibold, bold or mono; `size` is nominal points."""
    key = (kind, size)
    if key in _fonts:
        return _fonts[key]
    if kind == "mono":
        f = ImageFont.truetype(str(FONT_FILES["mono"]), px(size))
        f.set_variation_by_name("Regular")
    else:
        f = ImageFont.truetype(str(FONT_FILES["sans"]), px(size))
        values = []
        for axis in f.get_variation_axes():
            name = axis["name"]
            if name == b"Weight":
                values.append(WEIGHTS[kind])
            elif name == b"Optical Size":
                values.append(min(axis["maximum"], max(axis["minimum"], size)))
            else:
                values.append(axis["default"])
        f.set_variation_by_axes(values)
    _fonts[key] = f
    return f


def line_height(f: ImageFont.FreeTypeFont) -> int:
    ascent, descent = f.getmetrics()
    return int((ascent + descent) * 1.32)


def wrap(text: str, f: ImageFont.FreeTypeFont, max_width: int, draw: ImageDraw.ImageDraw) -> list[str]:
    """Wrap on real measured widths. An estimate here is what produces a clipped last word."""
    if not text:
        return []
    lines, words = [], text.split()
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if draw.textlength(candidate, font=f) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


_probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))


# Figures --------------------------------------------------------------------------------------


@dataclass
class Item:
    label: str
    note: str = ""
    mono: bool = False
    accent: bool = False


@dataclass
class Panel:
    title: str
    subtitle: str = ""
    items: list[Item] = field(default_factory=list)
    emphasis: bool = False
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


Line = tuple[int, int, ImageFont.FreeTypeFont, str, str, bool]


class Figure:
    """A white figure with the mark, a title and subtitle, and a 1 px rule under them."""

    PAD = 30

    def __init__(self, title: str, subtitle: str) -> None:
        self.title = title
        self.subtitle = subtitle
        self.f_title = font("bold", 18)
        self.f_sub = font("regular", 9)

    def header_left(self) -> int:
        return px(self.PAD) + px(30) + px(12)

    def subtitle_width(self) -> int:
        return px(FIGURE_WIDTH) - self.header_left() - px(self.PAD)

    def header_height(self) -> int:
        """A subtitle that wraps to two lines has to push the rule down."""
        lines = max(1, len(wrap(self.subtitle, self.f_sub, self.subtitle_width(), _probe)))
        return px(self.PAD) + line_height(self.f_title) + lines * line_height(self.f_sub) + px(20)

    def draw_header(self, image: Image.Image, draw: ImageDraw.ImageDraw, palette: Palette) -> None:
        left = top = px(self.PAD)
        size = px(30)
        mark = Image.open(MARK).convert("RGBA")
        mark.thumbnail((size, size), Image.LANCZOS)
        # Centred in its square, so a glyph wider than tall still sits on the title's line.
        image.paste(mark, (left + (size - mark.width) // 2, top + (size - mark.height) // 2), mark)
        draw.text((self.header_left(), top - px(2)), self.title, font=self.f_title, fill=palette.text)
        y = top - px(2) + line_height(self.f_title) - px(6)
        for line in wrap(self.subtitle, self.f_sub, self.subtitle_width(), draw):
            draw.text((self.header_left(), y), line, font=self.f_sub, fill=palette.text_muted)
            y += line_height(self.f_sub)
        rule_y = self.header_height() - px(11)
        draw.line([(px(self.PAD), rule_y), (px(FIGURE_WIDTH - self.PAD), rule_y)], fill=palette.rule, width=SCALE)

    def canvas(self, height: int, palette: Palette) -> tuple[Image.Image, ImageDraw.ImageDraw]:
        image = Image.new("RGB", (px(FIGURE_WIDTH), height), palette.page)
        return image, ImageDraw.Draw(image)

    @staticmethod
    def even(height: int) -> int:
        return height + (height % SCALE)

    @staticmethod
    def reduce(image: Image.Image) -> Image.Image:
        return image.resize((image.width // SCALE, image.height // SCALE), Image.LANCZOS)


class Columns(Figure):
    """Columns of stacked panels with arrows between adjacent columns."""

    PANEL_PAD = 15
    ITEM_GAP = 10
    PANEL_GAP = 14
    MIN_GUTTER = 26
    BULLET_COLUMN = 13

    def __init__(self, title: str, subtitle: str, columns: list[list[Panel]], arrows: list[tuple[str, str, str]]) -> None:
        super().__init__(title, subtitle)
        self.columns = columns
        self.arrows = arrows
        self.f_panel = font("semibold", 12)
        self.f_label = font("semibold", 10)
        self.f_mono = font("mono", 9)
        self.f_note = font("regular", 9)
        self.f_arrow = font("regular", 8)

    def measure_gutter(self) -> int:
        """Widen the column gap until the widest arrow label fits with shaft either side."""
        needed = px(self.MIN_GUTTER)
        for _, _, label in self.arrows:
            if label:
                needed = max(needed, int(_probe.textlength(label, font=self.f_arrow)) + px(26))
        return needed

    def pad(self) -> int:
        return px(self.PANEL_PAD)

    def flow(self, panel: Panel, width: int) -> list[Line]:
        """Every line as (dx, dy, font, text, role, bullet), relative to the panel's padding."""
        inner = width - 2 * self.pad()
        lines: list[Line] = []
        y = 0
        for text in wrap(panel.title, self.f_panel, inner, _probe):
            lines.append((0, y, self.f_panel, text, "title", False))
            y += line_height(self.f_panel)
        for text in wrap(panel.subtitle, self.f_note, inner, _probe):
            lines.append((0, y, self.f_note, text, "subtitle", False))
            y += line_height(self.f_note)
        y += px(9)
        indent = px(self.BULLET_COLUMN)
        for index, item in enumerate(panel.items):
            if index:
                y += px(self.ITEM_GAP)
            f = self.f_mono if item.mono else self.f_label
            role = "label-accent" if item.accent else "label"
            for n, text in enumerate(wrap(item.label, f, inner - indent, _probe)):
                lines.append((indent, y, f, text, role, n == 0))
                y += line_height(f)
            for text in wrap(item.note, self.f_note, inner - indent, _probe):
                lines.append((indent, y, self.f_note, text, "note", False))
                y += line_height(self.f_note)
        return lines

    def measure(self, panel: Panel, width: int) -> int:
        _, last_y, last_font, *_ = self.flow(panel, width)[-1]
        return self.pad() + last_y + line_height(last_font) + self.pad()

    def layout(self) -> int:
        gutter = self.measure_gutter()
        count = len(self.columns)
        inner = px(FIGURE_WIDTH) - 2 * px(self.PAD) - (count - 1) * gutter
        width = inner // count
        tallest = 0
        for c, column in enumerate(self.columns):
            y = self.header_height()
            for panel in column:
                panel.x = px(self.PAD) + c * (width + gutter)
                panel.y = y
                panel.width = width
                panel.height = self.measure(panel, width)
                y += panel.height + px(self.PANEL_GAP)
            tallest = max(tallest, y - px(self.PANEL_GAP))
        return self.even(tallest + px(self.PAD))

    def render(self, palette: Palette) -> Image.Image:
        height = self.layout()
        image, draw = self.canvas(height, palette)
        self.draw_header(image, draw, palette)
        for column in self.columns:
            for panel in column:
                self.draw_panel(draw, panel, palette)
        self.draw_arrows(draw, palette)
        return self.reduce(image)

    def draw_panel(self, draw: ImageDraw.ImageDraw, panel: Panel, palette: Palette) -> None:
        draw.rounded_rectangle(
            (panel.x, panel.y, panel.x + panel.width, panel.y + panel.height),
            radius=px(RADIUS_CARD),
            fill=palette.surface,
            outline=palette.accent if panel.emphasis else palette.border,
            width=SCALE * (2 if panel.emphasis else 1),
        )
        colours = {
            "title": palette.accent_text if panel.emphasis else palette.text,
            "subtitle": palette.text_muted,
            "label": palette.text,
            "label-accent": palette.accent_text,
            "note": palette.text_secondary,
        }
        origin_x, origin_y = panel.x + self.pad(), panel.y + self.pad()
        for dx, dy, f, text, role, bullet in self.flow(panel, panel.width):
            y = origin_y + dy
            if bullet:
                dot = y + line_height(f) // 2 - px(2) - px(1)
                draw.ellipse([origin_x + px(2), dot, origin_x + px(6), dot + px(4)], fill=palette.accent)
            draw.text((origin_x + dx, y), text, font=f, fill=colours[role])

    def draw_arrows(self, draw: ImageDraw.ImageDraw, palette: Palette) -> None:
        lookup = {panel.title: panel for column in self.columns for panel in column}
        for source, target, label in self.arrows:
            a, b = lookup[source], lookup[target]
            # The middle of the span both panels share, so the arrow always lands on its target.
            low, high = max(a.y, b.y), min(a.y + a.height, b.y + b.height)
            if high - low < px(24):
                raise SystemExit(f"ERROR: the arrow {source!r} -> {target!r} has no shared height to run along.")
            y = (low + high) // 2
            x1, x2 = a.x + a.width, b.x
            draw.line([(x1 + px(4), y), (x2 - px(7), y)], fill=palette.border_strong, width=SCALE)
            draw.polygon([(x2 - px(7), y - px(4)), (x2 - px(1), y), (x2 - px(7), y + px(4))], fill=palette.border_strong)
            if label:
                width = int(draw.textlength(label, font=self.f_arrow))
                mid = (x1 + x2) // 2
                draw.text((mid - width // 2, y - line_height(self.f_arrow) - px(2)), label, font=self.f_arrow, fill=palette.text_muted)


@dataclass
class Row:
    depth: int
    name: str
    note: str
    band: bool = False


class Tree(Figure):
    """An annotated file tree with drawn connector lines and one banded subtree."""

    CARD_PAD = 18
    INDENT = 16
    STUB = 8
    NAME_GAP = 20
    ROW_GAP = 6

    def __init__(self, title: str, subtitle: str, rows: list[Row]) -> None:
        super().__init__(title, subtitle)
        self.rows = rows
        self.f_name = font("mono", 9)
        self.f_note = font("regular", 9)

    def name_column(self) -> int:
        return max(px(self.INDENT) * row.depth + int(_probe.textlength(row.name, font=self.f_name)) for row in self.rows) + px(self.NAME_GAP)

    def card(self) -> tuple[int, int, int]:
        return px(self.PAD), self.header_height(), px(FIGURE_WIDTH - self.PAD)

    def row_layout(self) -> list[tuple[int, int, list[str]]]:
        """Each row's top, height (gap included) and wrapped note lines, in one pass."""
        left, top, right = self.card()
        text_left = left + px(self.CARD_PAD)
        note_width = right - px(self.CARD_PAD) - (text_left + self.name_column())
        y = top + px(self.CARD_PAD)
        out = []
        for row in self.rows:
            notes = wrap(row.note, self.f_note, note_width, _probe)
            height = max(line_height(self.f_name), len(notes) * line_height(self.f_note)) + px(self.ROW_GAP)
            out.append((y, height, notes))
            y += height
        return out

    def continues(self, index: int, depth: int) -> bool:
        """Whether a sibling at `depth` follows row `index` before the subtree closes."""
        for row in self.rows[index + 1 :]:
            if row.depth < depth:
                return False
            if row.depth == depth:
                return True
        return False

    def render(self, palette: Palette) -> Image.Image:
        layout = self.row_layout()
        left, top, right = self.card()
        last_top, last_height, _ = layout[-1]
        bottom = last_top + last_height - px(self.ROW_GAP) + px(self.CARD_PAD)
        image, draw = self.canvas(self.even(bottom + px(self.PAD)), palette)
        self.draw_header(image, draw, palette)
        draw.rounded_rectangle((left, top, right, bottom), radius=px(RADIUS_CARD), fill=palette.surface, outline=palette.border, width=SCALE)
        text_left = left + px(self.CARD_PAD)
        name_col = text_left + self.name_column()

        # Bands first, so lines and text land on top of them; contiguous rows share one band.
        index = 0
        while index < len(self.rows):
            if not self.rows[index].band:
                index += 1
                continue
            start = index
            while index < len(self.rows) and self.rows[index].band:
                index += 1
            band_top = layout[start][0] - px(3)
            band_bottom = layout[index - 1][0] + layout[index - 1][1] - px(self.ROW_GAP) + px(3)
            draw.rounded_rectangle((text_left - px(8), band_top, right - px(self.CARD_PAD) + px(8), band_bottom), radius=px(6), fill=palette.band)

        for i, row in enumerate(self.rows):
            y, height, notes = layout[i]
            mid = y + line_height(self.f_name) // 2 - px(1)
            # Pass-throughs for every ancestor level that still has a sibling below, then this row's elbow.
            for depth in range(1, row.depth):
                if self.continues(i, depth):
                    x = text_left + (depth - 1) * px(self.INDENT) + px(4)
                    draw.line([(x, y), (x, y + height)], fill=palette.border_strong, width=SCALE)
            if row.depth > 0:
                x = text_left + (row.depth - 1) * px(self.INDENT) + px(4)
                end = y + height if self.continues(i, row.depth) else mid
                draw.line([(x, y), (x, end)], fill=palette.border_strong, width=SCALE)
                draw.line([(x, mid), (x + px(self.STUB), mid)], fill=palette.border_strong, width=SCALE)
            directory = row.name.endswith("/") or "/  " in row.name
            draw.text((text_left + row.depth * px(self.INDENT), y), row.name, font=self.f_name, fill=palette.accent_text if directory else palette.text)
            note_y = y + (line_height(self.f_name) - line_height(self.f_note)) // 2
            for line in notes:
                draw.text((name_col, note_y), line, font=self.f_note, fill=palette.text_secondary)
                note_y += line_height(self.f_note)
        return self.reduce(image)


# The hero ---------------------------------------------------------------------------------------


def hero(palette: Palette, tagline: str) -> Image.Image:
    width, height = px(FIGURE_WIDTH), px(HERO_HEIGHT)
    inset = px(2)
    card = (inset, inset, width - inset - 1, height - inset - 1)

    gradient = Image.new("RGB", (width, height))
    fill = ImageDraw.Draw(gradient)
    top, bottom = parse_hex(palette.surface), parse_hex(palette.page)
    for row in range(height):
        t = row / max(1, height - 1)
        fill.line([(0, row), (width, row)], fill=tuple(int(top[c] + (bottom[c] - top[c]) * t) for c in range(3)))
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle(card, radius=px(22), fill=255)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(card, radius=px(22), outline=palette.border_strong, width=SCALE)

    # The lockup, sized by the height of its ink and placed by its alpha bbox, not its file box.
    source = Image.open(LOCKUP[palette.name]).convert("RGBA")
    art = source.getchannel("A").getbbox()
    assert art is not None
    ink = source.crop(art)
    ink_height = px(64)
    ink = ink.resize((round(ink.width * ink_height / ink.height), ink_height), Image.LANCZOS)

    f_tag = font("regular", 14)
    tag_box = draw.textbbox((0, 0), tagline, font=f_tag)
    tag_gap, rule_gap, rule_height = px(22), px(20), px(3)
    block = ink.height + tag_gap + (tag_box[3] - tag_box[1]) + rule_gap + rule_height
    y = inset + (height - 2 * inset - block) // 2
    image.paste(ink, ((width - ink.width) // 2, y), ink)
    y += ink.height + tag_gap
    draw.text(((width - (tag_box[2] - tag_box[0])) // 2 - tag_box[0], y - tag_box[1]), tagline, font=f_tag, fill=palette.text_muted)
    y += tag_box[3] - tag_box[1] + rule_gap
    draw.rounded_rectangle(((width - px(46)) // 2, y, (width + px(46)) // 2, y + rule_height), radius=px(2), fill=palette.accent)
    return image.resize((FIGURE_WIDTH, HERO_HEIGHT), Image.LANCZOS)


# Content ----------------------------------------------------------------------------------------

TAGLINE = "Trade the world's attention on NEAR."


def pipeline() -> Columns:
    return Columns(
        "How a trend becomes a market",
        "The radar proposes, NEAR AI Cloud reviews, an OutLayer enclave scores, and the registry accepts only what the enclave signed. Every market and every account guard reads the registry.",
        [
            [
                Panel(
                    "Oracle in a TEE",
                    "apps/oracle, every 5 minutes",
                    [
                        Item("request_execution", "OutLayer runs the index build, pinned by its sha256", mono=True),
                        Item("Key bound to the build", "An ed25519 key with bind: wasm, so only that exact build can sign a report"),
                        Item("11.5 s and 0.0013 NEAR a run", "Each report carries Hyperliquid marks for the account guard", accent=True),
                    ],
                ),
                Panel(
                    "Radar and review",
                    "backend, collectors and NEAR AI Cloud",
                    [
                        Item("Collectors", "Bluesky, Wikipedia, GDELT, Hacker News, CoinGecko, GeckoTerminal, Elfa, Nansen, pasted links"),
                        Item("Verifiable review", "Three NEAR AI Cloud models, cheapest first; an answer without a provider_tee signature is refused", accent=True),
                        Item("Review hash on the trend", "GET /v1/reviews/:hash serves the signed evidence"),
                    ],
                ),
            ],
            [
                Panel(
                    "registry",
                    "registry.tredio.testnet",
                    [
                        Item("env::ed25519_verify", "Accepts a report only with the oracle key's signature over its exact bytes", mono=True),
                        Item("0 to 100 index, 6 decimals", "The last 96 checkpoints on chain; the indexer keeps the full history"),
                        Item("Series and marks", "Opening and settlement values for Up/Down, attention fair value, Hyperliquid marks"),
                    ],
                    emphasis=True,
                ),
                Panel(
                    "Markets",
                    "four contracts that read the registry",
                    [
                        Item("outcomes and book", "NEP-245 Up/Down tokens, sets for 1 USDC, a price-time order book with 0.001 USDC ticks"),
                        Item("perps", "Attention perps up to 3x, funding from skew, keeper liquidation"),
                        Item("coins", "One NEP-141 per trend on a bonding curve that graduates into a Rhea pool"),
                    ],
                ),
                Panel(
                    "What it will not do",
                    "decisions, not gaps",
                    [
                        Item("Hold anyone's passkey", "Owner keys stay on the person's device; balances sit in their own account or a contract"),
                        Item("Run arbitrary session calls", "A session can only send typed trades under its caps"),
                    ],
                ),
            ],
            [
                Panel(
                    "Passkey account",
                    "one 0u universal account per person",
                    [
                        Item("Face ID, no seed phrase", "The P-256 passkey is checked on chain with the p256_verify host function"),
                        Item("A week-long session gas key", "NEP-611 gas key, typed actions, a daily USDC cap: trades need no prompt and no NEAR", accent=True),
                        Item("Hyperliquid through Chain Signatures", "The account signs an order only within 2% of a fresh mark and 10x leverage"),
                    ],
                ),
                Panel(
                    "Service fleet",
                    "Bun services on gas-key nonce lanes",
                    [
                        Item("relayer, keeper, market maker, top-up", "Parallel lanes on one gas key each, refilled from the treasury"),
                        Item("Autopilot and copy", "Rules and mainnet leaders mirrored through the person's autopilot session"),
                        Item("indexer", "Events from the FastNEAR transaction API into Postgres for history and PnL"),
                    ],
                ),
            ],
        ],
        [
            ("Oracle in a TEE", "registry", "signed report"),
            ("registry", "Passkey account", "marks, fair value"),
            ("Markets", "Service fleet", "quotes, settles"),
        ],
    )


def repository() -> Columns:
    return Columns(
        "What is in the repository",
        "Rust contracts on NEAR, TypeScript services on Bun, an API and three Next.js sites, in one pnpm workspace.",
        [
            [
                Panel(
                    "contracts/",
                    "Rust, near-sdk 5, one Cargo workspace",
                    [
                        Item("account/src/webauthn.rs", "P-256 passkey assertions verified with p256_verify, 1.3 Tgas", mono=True),
                        Item("account/src/hyperliquid.rs", "msgpack action, keccak connection id and EIP-712 digest built on chain", mono=True),
                        Item("registry/src/oracle.rs", "ed25519 report check, checkpoints, series settlement", mono=True),
                        Item("book/src/book.rs", "price-time priority with GTC, post-only and IOC orders", mono=True),
                        Item("accounts/src/lib.rs", "creates universal accounts from a global code hash", mono=True),
                        Item("AUDIT.md", "self-audit with the near-contract-audit checklist, every fix tested", mono=True),
                    ],
                    emphasis=True,
                ),
                Panel(
                    "scripts/  deployments/",
                    "proof you can rerun",
                    [
                        Item("scripts/verify.ts", "pnpm verify: reads testnet and checks the claims in JUDGES.md", mono=True),
                        Item("scripts/e2e-testnet.ts", "passkey sign-up to a closed perp on testnet in one run", mono=True),
                        Item("deployments/testnet.json", "every contract account and global code hash", mono=True),
                    ],
                ),
            ],
            [
                Panel(
                    "apps/",
                    "Bun services, each with /health and a Dockerfile",
                    [
                        Item("oracle/tee/", "the WASI build OutLayer runs; its sha256 is what the key is bound to", mono=True),
                        Item("relayer/", "checks activation tickets and passkey proofs before it pays", mono=True),
                        Item("keeper/  market-maker/  topup/", "settle series, quote ladders, refill every wallet", mono=True),
                        Item("autopilot/", "rules and copy-trading through each person's session", mono=True),
                        Item("indexer/", "the FastNEAR transaction feed into Postgres", mono=True),
                    ],
                ),
                Panel(
                    "packages/",
                    "shared TypeScript",
                    [
                        Item("chain/", "gas-key lanes, sign once and rebroadcast, NEP-413 and passkey proofs", mono=True),
                        Item("hyperliquid/  intents/", "the same Hyperliquid vectors as the contract; 1Click quotes", mono=True),
                        Item("mcp/", "read-only MCP server for AI agents", mono=True),
                    ],
                ),
            ],
            [
                Panel(
                    "backend/",
                    "Hono API on Postgres",
                    [
                        Item("src/ai/nearai.ts", "NEAR AI Cloud review, signature checked before a candidate is kept", mono=True),
                        Item("src/api/near-auth.ts", "NEP-413 sign-in by keys and sessions read on chain", mono=True),
                        Item("src/x402/", "paid endpoints settled in USDC on NEAR", mono=True),
                    ],
                ),
                Panel(
                    "frontend/  admin/  landing-page/",
                    "Next.js",
                    [
                        Item("frontend/src/lib/account/", "WebAuthn with PRF, the session key sealed in IndexedDB, NEAR Connect", mono=True),
                        Item("frontend/src/lib/chain/", "RPC failover, a gas-key sender with 4 nonce lanes, logged refusals", mono=True),
                        Item("admin/", "NEP-413 admin sign-in, chain and wallet health, manual topics", mono=True),
                    ],
                ),
            ],
        ],
        [],
    )


def tree() -> Tree:
    return Tree(
        "Where things are",
        "Every directory that matters. The banded subtree is the person's account contract, where the limits on every trade are enforced.",
        [
            Row(0, "Tredio/", "NEAR-native attention markets, one pnpm workspace"),
            Row(1, "contracts/", "Rust contracts and sandbox tests"),
            Row(2, "account/", "each person's 0u account: passkey owner, sessions, guards", band=True),
            Row(3, "src/lib.rs", "owner_execute, session_call, typed actions, the daily USDC cap", band=True),
            Row(3, "src/webauthn.rs", "the passkey proof, checked with p256_verify", band=True),
            Row(3, "src/hyperliquid.rs", "Hyperliquid orders signed through Chain Signatures", band=True),
            Row(2, "accounts/", "the factory: universal accounts from a global code hash"),
            Row(2, "registry/", "the attested index, series and marks"),
            Row(2, "outcomes/  book/", "Up/Down tokens and their order book"),
            Row(2, "perps/", "attention perps up to 3x"),
            Row(2, "coins/  coin/", "trend coins on a bonding curve"),
            Row(2, "tests/", "near-workspaces flows on a local nearcore"),
            Row(1, "apps/", "oracle (with the tee/ build), relayer, keeper, market maker, top-up, autopilot, indexer"),
            Row(1, "packages/", "chain, contracts-ts, hyperliquid, intents, autopilot, mcp"),
            Row(1, "backend/", "the API: radar, NEAR AI review, sign-in, Autopilot, status, x402"),
            Row(1, "frontend/", "the app at app.tredio.bid"),
            Row(1, "admin/", "the operator console"),
            Row(1, "landing-page/", "tredio.bid"),
            Row(1, "skills/tredio/", "the agent skill"),
            Row(1, "deployments/", "contract accounts per network"),
            Row(1, "scripts/", "the testnet end-to-end run and pnpm verify"),
        ],
    )


# Entry point ------------------------------------------------------------------------------------


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="report what would change and write nothing")
    args = parser.parse_args()

    for path in [MARK, *LOCKUP.values(), TOKENS]:
        if not path.is_file():
            print(f"ERROR: {path} is missing. Run assets/brand/export.sh icons first.")
            return 2
    for kind, path in FONT_FILES.items():
        if not path.is_file():
            print(f"ERROR: the {kind} font is missing at {path}.")
            return 2

    light, dark = palettes()
    problems = audit(dark) + audit(light)
    if problems:
        print("Contrast below AA; nothing written.")
        return 1

    images = {
        "hero-dark.png": hero(dark, TAGLINE),
        "hero-light.png": hero(light, TAGLINE),
        "pipeline.png": pipeline().render(light),
        "repository.png": repository().render(light),
        "tree.png": tree().render(light),
    }
    changed = 0
    for name, image in images.items():
        data = png_bytes(image)
        path = OUT / name
        old = path.read_bytes() if path.is_file() else None
        same = old is not None and hashlib.sha256(old).digest() == hashlib.sha256(data).digest()
        status = "same" if same else ("new" if old is None else "changed")
        print(f"  {status:8} {path.relative_to(ROOT)}  {image.width}x{image.height}")
        if not same:
            changed += 1
            if not args.check:
                OUT.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
    if args.check:
        print(f"{changed} image(s) would change.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
