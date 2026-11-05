import { ImageResponse } from "next/og";
import { C, DISPLAY, Frame, OG_SIZE, ogFonts } from "@/features/share/og";

export const alt = "Tredio: trade what the world pays attention to";
export const size = OG_SIZE;
export const contentType = "image/png";

/** A stylized attention index climbing across the card. */
const CURVE = [22, 24, 23, 27, 26, 31, 29, 34, 38, 36, 41, 47, 44, 52, 58, 55, 63, 71, 68, 77, 84, 81, 90];

function Curve({ width, height }: { width: number; height: number }) {
  const min = Math.min(...CURVE);
  const max = Math.max(...CURVE);
  // Inset by the end dot so it is never cut by the card's edge.
  const pts = CURVE.map((v, i) => [(i / (CURVE.length - 1)) * (width - 16), 14 + (1 - (v - min) / (max - min)) * (height - 28)] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1]!;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={C.primary} stopOpacity={0.3} />
          <stop offset="100%" stopColor={C.primary} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${lx} ${height} L0 ${height} Z`} fill="url(#area)" />
      <path d={line} fill="none" stroke={C.primary} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={9} fill={C.bg} stroke={C.primary} strokeWidth={4} />
    </svg>
  );
}

export default function Image() {
  return new ImageResponse(
    (
      <Frame eyebrow="Attention markets" footer="Outcome markets · attention perps · asset perps">
        <div style={{ display: "flex", flexDirection: "column", marginTop: 58, maxWidth: 820 }}>
          <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 92, lineHeight: 1.02, letterSpacing: "-0.01em", color: C.text }}>Trade the narrative itself.</div>
          <div style={{ display: "flex", marginTop: 26, fontSize: 31, lineHeight: 1.4, color: C.text2 }}>Up or down on any trend&rsquo;s attention, measured live by the Tredio oracle. One passkey, no gas.</div>
        </div>
        <div style={{ position: "absolute", right: 0, bottom: 0, display: "flex" }}>
          <Curve width={500} height={200} />
        </div>
      </Frame>
    ),
    { ...size, fonts: ogFonts },
  );
}
