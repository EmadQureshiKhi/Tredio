import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactNode } from "react";
import { APP_URL } from "@/lib/config";

/**
 * Building blocks for the link cards (next/og ImageResponse, 1200 x 630): the brand's fonts,
 * colors and frame. ImageResponse reads TTF, OTF and WOFF but not WOFF2, so the app's fonts are
 * kept here as TTF converted from app/fonts (same faces, same names).
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

const fontDir = join(process.cwd(), "src", "features", "share", "fonts");
const brandDir = join(process.cwd(), "public");
const [light, display, strong, wordmark] = await Promise.all([
  readFile(join(fontDir, "sohne-leicht.ttf")),
  readFile(join(fontDir, "arizona-mix-light.ttf")),
  readFile(join(fontDir, "sohne-kraftig.ttf")),
  readFile(join(brandDir, "tredio-icon-logo.svg"), "base64"),
]);

export const ogFonts = [
  { name: "Sohne", data: light, weight: 300 as const, style: "normal" as const },
  { name: "Sohne", data: strong, weight: 500 as const, style: "normal" as const },
  { name: "Arizona", data: display, weight: 400 as const, style: "normal" as const },
];

/** The dark theme's tokens (app/globals.css). */
export const C = {
  bg: "#09090b",
  surface: "#111113",
  surface2: "#18181b",
  line: "rgba(255,255,255,0.09)",
  lineStrong: "rgba(255,255,255,0.16)",
  text: "#fafafa",
  text2: "rgba(250,250,250,0.62)",
  text3: "rgba(250,250,250,0.42)",
  primary: "#a49bf0",
  primarySoft: "rgba(164,155,240,0.16)",
  accent: "#e0ff98",
  up: "#34d399",
  upSoft: "rgba(52,211,153,0.14)",
  down: "#f87171",
  downSoft: "rgba(248,113,113,0.14)",
  warn: "#fbbf24",
} as const;

export const SANS = "Sohne";
export const DISPLAY = "Arizona";

const host = APP_URL.replace(/^https?:\/\//, "");

/** The card's frame: the wordmark and an eyebrow on top, the content, then the address. */
export function Frame({ eyebrow, children, footer, glow = C.primary }: { eyebrow?: ReactNode; children: ReactNode; footer?: ReactNode; glow?: string }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", position: "relative", background: C.bg, color: C.text, fontFamily: SANS, fontWeight: 300, padding: "56px 64px 48px" }}>
      {/* A soft glow in the corner, like the app's hero card. */}
      <svg width={820} height={820} viewBox="0 0 820 820" style={{ position: "absolute", top: -340, right: -300 }}>
        <defs>
          <radialGradient id="glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={glow} stopOpacity={0.2} />
            <stop offset="45%" stopColor={glow} stopOpacity={0.07} />
            <stop offset="100%" stopColor={glow} stopOpacity={0} />
          </radialGradient>
        </defs>
        <rect width={820} height={820} fill="url(#glow)" />
      </svg>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain img tags */}
        <img src={`data:image/svg+xml;base64,${wordmark}`} width={154} height={27} alt="" />
        {eyebrow ? <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 21, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: C.primary }}>{eyebrow}</div> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, position: "relative" }}>{children}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `1px solid ${C.line}`, paddingTop: 22, fontSize: 21, color: C.text3 }}>
        <div style={{ display: "flex" }}>{footer ?? "Attention markets"}</div>
        <div style={{ display: "flex", color: C.text2 }}>{host}</div>
      </div>
    </div>
  );
}

/** A pill like the app's Badge. */
export function Pill({ children, color = C.text2, background = C.surface2, size = 20 }: { children: ReactNode; color?: string; background?: string; size?: number }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, height: size * 1.8, padding: `0 ${size * 0.75}px`, borderRadius: 999, background, color, fontSize: size, fontWeight: 500, letterSpacing: "0.02em" }}>{children}</div>;
}

/** An SVG line and area for `values`, the stroke colored by direction (flat is neutral). */
export function Spark({ values, width, height, strokeWidth = 4 }: { values: readonly number[]; width: number; height: number; strokeWidth?: number }) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <div style={{ display: "flex", width, height }} />;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const flat = max - min < 1e-9;
  const pad = strokeWidth * 2;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * width, flat ? height / 2 : pad + (1 - (x - min) / (max - min)) * (height - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const color = flat ? C.text3 : v[v.length - 1]! >= v[0]! ? C.up : C.down;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {flat ? null : <path d={`${line} L${width} ${height} L0 ${height} Z`} fill="url(#fill)" />}
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** A signed percent, like the app's Delta. */
export const signedPct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(digits)}%`);
export const toneOf = (v: number | null | undefined) => (v === null || v === undefined || Math.abs(v) < 0.05 ? C.text3 : v > 0 ? C.up : C.down);
export const softOf = (v: number | null | undefined) => (v === null || v === undefined || Math.abs(v) < 0.05 ? C.surface2 : v > 0 ? C.upSoft : C.downSoft);

/** Long names shrink so two lines always fit. */
export const titleSize = (text: string, base: number) => (text.length > 34 ? Math.round(base * 0.72) : text.length > 22 ? Math.round(base * 0.86) : base);
