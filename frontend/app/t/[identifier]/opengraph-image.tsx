import { ImageResponse } from "next/og";
import { attentionStory, trendCard, trendName } from "@/features/share/data";
import { C, DISPLAY, Frame, OG_SIZE, ogFonts, Pill, signedPct, softOf, Spark, titleSize, toneOf } from "@/features/share/og";
import { assetClassLabel } from "@/lib/format";

export const alt = "A trend's live attention index on Tredio";
export const size = OG_SIZE;
export const contentType = "image/png";
// The index moves every minute; cards are refreshed every few minutes.
export const revalidate = 300;

export default async function Image({ params }: { params: Promise<{ identifier: string }> }) {
  const identifier = decodeURIComponent((await params).identifier);
  const t = await trendCard(identifier);

  if (!t) {
    return new ImageResponse(
      (
        <Frame eyebrow="Attention index">
          <div style={{ display: "flex", flexDirection: "column", marginTop: 72 }}>
            <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 84, lineHeight: 1.05 }}>Not trending yet</div>
            <div style={{ display: "flex", marginTop: 22, fontSize: 30, color: C.text2 }}>{identifier.slice(0, 60)}</div>
          </div>
        </Frame>
      ),
      { ...size, fonts: ogFonts },
    );
  }

  const name = trendName(t);
  const spark = t.spark && t.spark.length > 1 ? t.spark : [t.index, t.index];
  const story = attentionStory(t).slice(0, 3);
  const status = t.status === "retired" ? "Retired" : t.status === "cooling" ? "Cooling" : "Live";
  return new ImageResponse(
    (
      <Frame eyebrow={<>{assetClassLabel(t.assetClass)} · attention index</>} footer={story.length ? story.join("  ·  ") : "Measured by the oracle"}>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 44 }}>
          <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: titleSize(name, 76), lineHeight: 1.04, maxWidth: 1000, letterSpacing: "-0.01em" }}>{name}</div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "flex-end", justifyContent: "space-between", paddingBottom: 30 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 22, color: C.text3, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              <div style={{ display: "flex", width: 12, height: 12, borderRadius: 12, background: t.status === "active" ? C.up : t.status === "cooling" ? C.warn : C.text3 }} />
              {status}
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 22, marginTop: 6 }}>
              <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 168, lineHeight: 0.9, letterSpacing: "-0.02em" }}>{t.index.toFixed(1)}</div>
              <div style={{ display: "flex", marginBottom: 14 }}>
                <Pill color={toneOf(t.change24h)} background={softOf(t.change24h)} size={26}>
                  {signedPct(t.change24h)} 24h
                </Pill>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", marginBottom: 6 }}>
            <Spark values={spark} width={430} height={170} strokeWidth={5} />
          </div>
        </div>
      </Frame>
    ),
    { ...size, fonts: ogFonts },
  );
}
