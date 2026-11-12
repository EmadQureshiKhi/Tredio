"""README figures as SVG, each in a light and a dark version (assets/readme/*-light.svg, *-dark.svg).

Blueprint style: a dotted grid, lanes tinted by layer (signal, NEAR, people and agents), numbered
connectors with label chips, monospace captions. Colours come from the app's own theme
(frontend/app/globals.css) and the logo from frontend/public/tredio-icon-logo.svg, so the figures
follow the product. No dependencies: run `python3 tools/readme_figures.py`.
"""
from __future__ import annotations

import re
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "readme"
CSS = (ROOT / "frontend" / "app" / "globals.css").read_text()
LOGO = (ROOT / "frontend" / "public" / "tredio-icon-logo.svg").read_text()

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"


def tokens(block: str) -> dict[str, str]:
    return dict(re.findall(r"--([a-z0-9-]+):\s*([^;]+);", block))


# The first block is the dark theme (:root), the second the light one.
_blocks = re.findall(r"\{([^{}]*--bg:[^{}]*)\}", CSS)
DARK, LIGHT = tokens(_blocks[0]), tokens(_blocks[1])


def theme(dark: bool) -> dict[str, str]:
    t = DARK if dark else LIGHT
    return {
        "bg": t["bg"],
        "panel": t["surface"],
        "panel2": t["surface-2"],
        "line": t["line-strong"],
        "dot": "rgba(255,255,255,0.07)" if dark else "rgba(9,9,11,0.09)",
        "text": t["text"],
        "text2": t["text-2"],
        "text3": t["text-3"],
        # One hue per layer: NEAR (the brand's primary), the signal path (lime on dark, olive on light),
        # people and agents (the app's Up green), and neutral for outside networks.
        "chain": t["primary"],
        "signal": t["accent"] if dark else "#6b7d12",
        "people": t["up"] if dark else "#0f8a5f",
        "ext": "rgba(250,250,250,0.55)" if dark else "rgba(11,11,13,0.55)",
        "down": t["down"],
    }


def soft(color: str, alpha: float) -> str:
    """A translucent version of a #rrggbb colour (other formats pass through at their own alpha)."""
    if color.startswith("#") and len(color) == 7:
        r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
        return f"rgba({r},{g},{b},{alpha})"
    return color


class Svg:
    def __init__(self, w: int, h: int, dark: bool, title: str):
        self.w, self.h, self.c = w, h, theme(dark)
        self.dark = dark
        self.parts: list[str] = []
        self.title = title

    def add(self, s: str) -> None:
        self.parts.append(s)

    def text(self, x, y, s, size=13, weight=400, color=None, mono=False, anchor="start", spacing=None, opacity=None):
        fam = MONO if mono else SANS
        ls = f' letter-spacing="{spacing}"' if spacing is not None else ""
        op = f' opacity="{opacity}"' if opacity is not None else ""
        self.add(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" fill="{color or self.c["text"]}" text-anchor="{anchor}"{ls}{op}>{escape(s)}</text>')

    def frame(self) -> None:
        c = self.c
        self.add(
            f'<defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="{c["dot"]}"/></pattern>'
            f'<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="{c["text2"]}"/></marker></defs>'
        )
        self.add(f'<rect x="0.5" y="0.5" width="{self.w - 1}" height="{self.h - 1}" rx="18" fill="{c["bg"]}" stroke="{c["line"]}"/>')
        self.add(f'<rect x="0.5" y="0.5" width="{self.w - 1}" height="{self.h - 1}" rx="18" fill="url(#dots)"/>')

    def band(self, y, h, label, color) -> None:
        self.add(f'<rect x="20" y="{y}" width="{self.w - 40}" height="{h}" rx="14" fill="{soft(color, 0.05)}" stroke="{soft(color, 0.28)}" stroke-dasharray="4 5"/>')
        self.text(36, y + 22, label, size=11, weight=600, color=color, mono=True, spacing=1.6)

    def box(self, x, y, w, h, title, lines, color, tag=None, strong=False) -> None:
        c = self.c
        sw = 2 if strong else 1.2
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{c["panel"]}" stroke="{color if strong else soft(color, 0.55)}" stroke-width="{sw}"/>')
        self.add(f'<rect x="{x}" y="{y}" width="5" height="{h}" rx="2.5" fill="{color}"/>')
        self.text(x + 18, y + 26, title, size=15, weight=650)
        if tag:
            tw = 8 + 7.2 * len(tag)
            self.add(f'<rect x="{x + w - tw - 12}" y="{y + 12}" width="{tw}" height="20" rx="10" fill="{soft(color, 0.16)}" stroke="{soft(color, 0.5)}"/>')
            self.text(x + w - tw / 2 - 12, y + 26, tag, size=10.5, weight=600, color=color, mono=True, anchor="middle")
        for i, line in enumerate(lines):
            self.text(x + 18, y + 48 + i * 18, line, size=12, color=c["text2"], mono=True)

    def chip(self, x, y, label, num=None) -> None:
        c = self.c
        w = 14 + 6.9 * len(label) + (22 if num else 0)
        self.add(f'<rect x="{x - w / 2}" y="{y - 11}" width="{w}" height="22" rx="11" fill="{c["panel2"]}" stroke="{c["line"]}"/>')
        tx = x - w / 2 + 8
        if num:
            self.add(f'<circle cx="{tx + 7}" cy="{y}" r="8" fill="{c["text"]}"/>')
            self.text(tx + 7, y + 4, str(num), size=10.5, weight=700, color=c["bg"], mono=True, anchor="middle")
            tx += 20
        self.text(tx, y + 4, label, size=11.5, color=c["text"], mono=True)

    def dot(self, x, y, num) -> None:
        c = self.c
        self.add(f'<circle cx="{x}" cy="{y}" r="10.5" fill="{c["text"]}" stroke="{c["bg"]}" stroke-width="2"/>')
        self.text(x, y + 4, str(num), size=11, weight=700, color=c["bg"], mono=True, anchor="middle")

    def path(self, pts, dashed=False, color=None) -> None:
        d = "M" + " L".join(f"{x} {y}" for x, y in pts)
        dash = ' stroke-dasharray="5 5"' if dashed else ""
        self.add(f'<path d="{d}" fill="none" stroke="{color or self.c["text2"]}" stroke-width="1.6"{dash} marker-end="url(#arrow)"/>')

    def logo(self, x, y, height) -> None:
        inner = re.sub(r"^.*?<title>.*?</title>", "", LOGO, flags=re.S).replace("</svg>", "")
        if not self.dark:
            inner = inner.replace("#FAFAFA", self.c["text"])
        scale = height / 72
        self.add(f'<g transform="translate({x} {y}) scale({scale})">{inner}</g>')

    def render(self) -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" viewBox="0 0 {self.w} {self.h}" role="img" aria-label="{escape(self.title)}">'
            f"<title>{escape(self.title)}</title>" + "".join(self.parts) + "</svg>\n"
        )


def curve(points: list[tuple[float, float]]) -> str:
    """A smooth path through points (Catmull-Rom as cubic Béziers)."""
    d = f"M{points[0][0]:.1f} {points[0][1]:.1f}"
    for i in range(len(points) - 1):
        p0 = points[max(i - 1, 0)]
        p1, p2 = points[i], points[i + 1]
        p3 = points[min(i + 2, len(points) - 1)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}"
    return d


def hero(dark: bool) -> str:
    s = Svg(1200, 380, dark, "Tredio: trade the world's attention on NEAR")
    s.frame()
    c = s.c
    s.logo(64, 58, 40)
    s.text(64, 150, "Trade the world's attention.", size=46, weight=750, spacing=-1)
    s.text(64, 190, "Trends scored from 0 to 100 by an oracle in an OutLayer enclave, settled on NEAR,", size=17, color=c["text2"])
    s.text(64, 214, "traded from Face ID accounts with no seed phrase and no gas.", size=17, color=c["text2"])
    chips = ["Up/Down series", "Attention perps", "Trend coins", "Hyperliquid perps", "Autopilot", "Calls"]
    x = 64
    for label in chips:
        w = 26 + 7.6 * len(label)
        s.add(f'<rect x="{x}" y="252" width="{w}" height="30" rx="15" fill="{soft(c["chain"], 0.1)}" stroke="{soft(c["chain"], 0.45)}"/>')
        s.text(x + w / 2, 272, label, size=13, weight=600, color=c["chain"], anchor="middle")
        x += w + 10
    s.text(64, 330, "NEAR testnet · app.tredio.bid · pnpm verify checks every claim", size=12.5, color=c["text3"], mono=True)
    # An illustrative attention index card on the right.
    x0, y0, w, h = 860, 54, 290, 210
    s.add(f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" rx="16" fill="{c["panel"]}" stroke="{c["line"]}"/>')
    s.text(x0 + 20, y0 + 30, "ATTENTION INDEX", size=10.5, weight=600, color=c["text3"], mono=True, spacing=1.4)
    for i, v in enumerate([100, 50, 0]):
        gy = y0 + 56 + i * 60
        s.add(f'<line x1="{x0 + 20}" y1="{gy}" x2="{x0 + w - 44}" y2="{gy}" stroke="{c["line"]}" stroke-dasharray="3 4"/>')
        s.text(x0 + w - 20, gy + 4, str(v), size=10.5, color=c["text3"], mono=True, anchor="end")
    vals = [22, 24, 23, 31, 46, 62, 74, 71, 79, 88, 84, 77]
    pts = [(x0 + 20 + i * (w - 64) / (len(vals) - 1), y0 + 176 - v * 1.2) for i, v in enumerate(vals)]
    area = curve(pts) + f" L{pts[-1][0]:.1f} {y0 + 176} L{pts[0][0]:.1f} {y0 + 176} Z"
    s.add(f'<path d="{area}" fill="{soft(c["chain"], 0.12)}"/>')
    s.add(f'<path d="{curve(pts)}" fill="none" stroke="{c["chain"]}" stroke-width="2.6"/>')
    s.add(f'<circle cx="{pts[-1][0]:.1f}" cy="{pts[-1][1]:.1f}" r="4.5" fill="{c["chain"]}"/>')
    s.add(f'<rect x="{x0 + 20}" y="{y0 + h - 2}" width="0" height="0"/>')
    s.text(x0 + 20, y0 + h + 30, "illustrative", size=10.5, color=c["text3"], mono=True)
    return s.render()


def architecture(dark: bool) -> str:
    s = Svg(1200, 790, dark, "Tredio's architecture: from public sources to an enclave-signed index on NEAR, traded by passkey accounts, agents and services")
    s.frame()
    c = s.c
    s.text(40, 46, "How Tredio fits together", size=20, weight=700)
    s.text(1160, 46, "solid: a call or a transaction · dashed: read only", size=11.5, color=c["text3"], mono=True, anchor="end")
    s.band(66, 196, "SIGNAL · OFF CHAIN", c["signal"])
    s.band(286, 196, "NEAR TESTNET", c["chain"])
    s.band(506, 176, "PEOPLE · AGENTS · SERVICES", c["people"])
    W = 250
    s.box(40, 100, W, 140, "Public sources", ["X and Telegram (Elfa)", "GDELT news, Wikipedia", "Bluesky, Hacker News", "Nansen smart money"], c["signal"])
    s.box(330, 100, W, 140, "Tredio API", ["collector and radar", "NEAR AI Cloud review", "(TEE-signed evidence)", "status, social, x402"], c["signal"])
    s.box(620, 100, W, 140, "Oracle", ["WASI build on OutLayer", "key bound to its sha256", "a signed report a minute", "attested TDX quote"], c["signal"], tag="TEE", strong=True)
    s.box(910, 100, W, 140, "Hyperliquid", ["perps on a trend's asset", "marks for the oracle", "orders signed by NEAR", "accounts (Chain Sigs)"], c["ext"])
    s.box(40, 320, W, 140, "Passkey account", ["0u... universal account", "P-256 owner, Face ID", "session gas keys (NEP-611)", "daily cap, 2% / 10x guard"], c["chain"])
    s.box(330, 320, 170, 140, "outcomes + book", ["Up/Down tokens", "NEP-245, 1 USDC", "order book"], c["chain"])
    s.box(515, 320, 170, 140, "perps", ["long or short", "the index, 3x", "funding, liquidation"], c["chain"])
    s.box(700, 320, 170, 140, "coins", ["a curve per trend", "floor ratchets", "graduates to Rhea"], c["chain"])
    s.box(910, 320, W, 140, "registry", ["the signed index", "series open and settle", "Hyperliquid marks", "ed25519 check, 50% clamp"], c["chain"], strong=True)
    s.box(40, 540, W, 110, "App", ["app.tredio.bid", "sign up with Face ID", "trade with no prompt"], c["people"])
    s.box(330, 540, W, 110, "Agents", ["MCP server, agent skill", "x402 paid endpoints", "Agent Market @tredio"], c["people"])
    s.box(620, 540, W, 110, "Services", ["keeper, market maker", "relayer, top-up", "Autopilot, indexer"], c["people"])
    s.box(910, 540, W, 110, "Admin", ["admin.tredio.bid", "reviews, moderation", "system health"], c["people"])
    # Numbered dots on the arrows; the legend under the lanes says what each one carries.
    s.path([(290, 170), (326, 170)])
    s.dot(308, 170, 1)
    s.path([(580, 170), (616, 170)])
    s.dot(598, 170, 2)
    s.path([(910, 170), (874, 170)], dashed=True)
    s.dot(892, 170, 3)
    s.path([(745, 240), (745, 270), (1035, 270), (1035, 316)])
    s.dot(890, 270, 4)
    s.path([(910, 390), (874, 390)], dashed=True)
    s.dot(892, 390, 5)
    s.path([(290, 390), (326, 390)])
    s.dot(308, 390, 6)
    s.path([(165, 540), (165, 464)])
    s.dot(165, 502, 7)
    s.path([(455, 540), (455, 464)])
    s.dot(455, 502, 8)
    s.path([(745, 540), (745, 464)])
    s.dot(745, 502, 9)
    legend = [
        "readings from every source", "the enclave reads them via the API", "Hyperliquid marks for the oracle",
        "one signed report a minute", "markets read the index", "trades are session_calls",
        "a passkey signs up and approves", "agents trade within a policy", "services quote, settle, liquidate",
    ]
    for i, label in enumerate(legend):
        lx, ly = 52 + (i % 3) * 380, 712 + (i // 3) * 26
        s.dot(lx, ly - 4, i + 1)
        s.text(lx + 20, ly, label, size=12, color=c["text2"], mono=True)
    return s.render()


def trust(dark: bool) -> str:
    s = Svg(1200, 560, dark, "Tredio's trust model: who signs, what checks the signature, and what it can move")
    s.frame()
    c = s.c
    s.text(40, 46, "Who can move what", size=20, weight=700)
    heads = [("WHO SIGNS", 40), ("WHAT CHECKS IT, ON CHAIN OR IN THE API", 420), ("WHAT IT CAN MOVE", 870)]
    for label, x in heads:
        s.text(x, 84, label, size=11, weight=600, color=c["text3"], mono=True, spacing=1.4)
    rows = [
        ("The enclave's key", "OutLayer, bound to the build hash", "registry: env::ed25519_verify, run id,", "time window, 50% move clamp", "the index, settlements, marks", c["signal"]),
        ("Your passkey", "P-256, Face ID or a fingerprint", "account: p256_verify over SHA-256 of", "the request, user verification on v3", "sessions, withdrawals, upgrades", c["chain"]),
        ("A session gas key", "NEP-611, prepays its own gas", "account: typed actions only, a daily", "USDC cap, anchored prices, 2% / 10x", "trades, never withdrawals", c["chain"]),
        ("The relayer", "pays for sign-ups and requests", "checks the passkey proof itself and", "an activation ticket from the API", "nothing it was not asked to send", c["people"]),
        ("NEP-413 sign-in", "a full-access or session key", "API: reads the key on chain, recipient", "tredio.bid (admin: admin.tredio.bid)", "an API session, never funds", c["people"]),
    ]
    y = 100
    for i, (who, who2, chk, chk2, moves, color) in enumerate(rows):
        s.add(f'<rect x="30" y="{y}" width="1140" height="78" rx="12" fill="{c["panel"]}" stroke="{c["line"]}"/>')
        s.add(f'<circle cx="58" cy="{y + 39}" r="13" fill="{soft(color, 0.18)}" stroke="{color}"/>')
        s.text(58, y + 44, str(i + 1), size=12, weight=700, color=color, mono=True, anchor="middle")
        s.text(84, y + 34, who, size=15, weight=650)
        s.text(84, y + 56, who2, size=12, color=c["text2"], mono=True)
        s.path([(372, y + 39), (410, y + 39)])
        s.text(420, y + 34, chk, size=12.5, color=c["text"], mono=True)
        s.text(420, y + 54, chk2, size=12.5, color=c["text"], mono=True)
        s.path([(822, y + 39), (860, y + 39)])
        s.add(f'<rect x="870" y="{y + 22}" width="286" height="34" rx="17" fill="{soft(color, 0.1)}" stroke="{soft(color, 0.45)}"/>')
        s.text(1013, y + 44, moves, size=12.5, weight=600, color=color, anchor="middle")
        y += 88
    return s.render()


def lifecycle(dark: bool) -> str:
    s = Svg(1200, 400, dark, "A trend's life on Tredio: spotted, reviewed, listed, traded, settled, retired")
    s.frame()
    c = s.c
    s.text(40, 46, "A trend's life", size=20, weight=700)
    s.text(1160, 46, "index, 0 to 100 (illustrative)", size=11.5, color=c["text3"], mono=True, anchor="end")
    xs = [110, 306, 502, 698, 894, 1090]
    base = 240
    vals = [8, 18, 38, 74, 86, 60, 41, 22, 12]
    pts = [(80 + i * (1040 / (len(vals) - 1)), base - 14 - v * 1.3) for i, v in enumerate(vals)]
    area = curve(pts) + f" L{pts[-1][0]:.1f} {base} L{pts[0][0]:.1f} {base} Z"
    s.add(f'<path d="{area}" fill="{soft(c["chain"], 0.1)}"/>')
    s.add(f'<path d="{curve(pts)}" fill="none" stroke="{c["chain"]}" stroke-width="2.4" opacity="0.9"/>')
    s.add(f'<line x1="70" y1="{base}" x2="1130" y2="{base}" stroke="{c["text2"]}" stroke-width="1.5"/>')
    stations = [
        ("Spotted", ["the radar finds it", "in public sources"], c["signal"]),
        ("Reviewed", ["NEAR AI Cloud, the", "evidence TEE-signed"], c["signal"]),
        ("Listed", ["the oracle reports it", "at 5 points or more"], c["chain"]),
        ("Traded", ["24 h and 7 d series,", "perps, its coin"], c["chain"]),
        ("Settled", ["the registry's value", "at expiry pays out"], c["people"]),
        ("Retired", ["stale or rotated out;", "winners redeem"], c["people"]),
    ]
    for i, (x, (title, lines, color)) in enumerate(zip(xs, stations)):
        s.add(f'<circle cx="{x}" cy="{base}" r="15" fill="{c["bg"]}" stroke="{color}" stroke-width="2"/>')
        s.text(x, base + 5, str(i + 1), size=12.5, weight=700, color=color, mono=True, anchor="middle")
        s.add(f'<rect x="{x - 88}" y="{base + 34}" width="176" height="96" rx="12" fill="{c["panel"]}" stroke="{soft(color, 0.5)}"/>')
        s.text(x, base + 60, title, size=15, weight=650, anchor="middle")
        for j, line in enumerate(lines):
            s.text(x, base + 84 + j * 18, line, size=11.5, color=c["text2"], mono=True, anchor="middle")
    return s.render()


FIGURES = {"hero": hero, "architecture": architecture, "trust": trust, "lifecycle": lifecycle}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, draw in FIGURES.items():
        for dark in (False, True):
            path = OUT / f"{name}-{'dark' if dark else 'light'}.svg"
            path.write_text(draw(dark))
            print("wrote", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
