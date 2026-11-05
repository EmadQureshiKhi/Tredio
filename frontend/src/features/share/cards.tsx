import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { baseIdentifier, callerName, horizonLabel, type SharedCall, trendName } from "./data";
import { C, DISPLAY, Frame, OG_SIZE, ogFonts, Pill, signedPct, softOf, titleSize, toneOf } from "./og";
import { type PnlShare, pnlHeadline, trimZeros } from "./share";

/** Link cards for a call and a PnL result (1200 x 630, the brand's dark frame). */

const OUTCOME: Record<string, { label: string; color: string; bg: string }> = {
  open: { label: "Open", color: C.text2, bg: C.surface2 },
  hit: { label: "Hit", color: C.up, bg: C.upSoft },
  miss: { label: "Miss", color: C.down, bg: C.downSoft },
  void: { label: "Void", color: C.text2, bg: C.surface2 },
};

function Arrow({ up, color, size }: { up: boolean; color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d={up ? "M12 19V5M5 12l7-7 7 7" : "M12 5v14M5 12l7 7 7-7"} fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function callImage(data: SharedCall | null) {
  if (!data) {
    return new ImageResponse(
      (
        <Frame eyebrow="Call">
          <div style={{ display: "flex", marginTop: 72, fontFamily: DISPLAY, fontSize: 84 }}>This call is not here anymore</div>
        </Frame>
      ),
      { ...OG_SIZE, fonts: ogFonts },
    );
  }
  const { call, trend, record } = data;
  const up = call.direction === "up";
  const name = trend ? trendName(trend) : baseIdentifier(call.identifier ?? "");
  const outcome = OUTCOME[call.outcome] ?? OUTCOME.open!;
  const opening = Number(call.opening_index);
  const closing = call.closing_index === null ? null : Number(call.closing_index);
  const now = trend?.index ?? null;
  const shown = closing ?? now;
  const move = shown !== null && opening > 0 ? ((shown - opening) / opening) * 100 : null;
  const dirColor = up ? C.up : C.down;
  const resolved = record ? record.hits + record.misses : 0;
  return new ImageResponse(
    (
      <Frame eyebrow={<>{horizonLabel(call.horizon_sec)} call</>} footer={record && resolved > 0 ? `${callerName(call)}: ${Math.round(record.hitRate * 100)}% hit rate over ${resolved} resolved calls` : `${callerName(call)} on Tredio`}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 40, fontSize: 30, color: C.text2 }}>
          <div style={{ display: "flex", color: C.text, fontWeight: 500 }}>{callerName(call)}</div>
          <div style={{ display: "flex" }}>called</div>
          <Pill color={dirColor} background={up ? C.upSoft : C.downSoft} size={26}>
            <Arrow up={up} color={dirColor} size={26} />
            {up ? "UP" : "DOWN"}
          </Pill>
        </div>
        <div style={{ display: "flex", marginTop: 18, fontFamily: DISPLAY, fontSize: titleSize(name, 80), lineHeight: 1.04, maxWidth: 1060, letterSpacing: "-0.01em" }}>{name}</div>
        {call.note ? <div style={{ display: "flex", marginTop: 16, fontSize: 26, lineHeight: 1.4, color: C.text2, maxWidth: 980, maxHeight: 74, overflow: "hidden" }}>&ldquo;{call.note.slice(0, 140)}&rdquo;</div> : null}
        <div style={{ display: "flex", flex: 1, alignItems: "flex-end", gap: 64, paddingBottom: 24 }}>
          <Stat label="Called at" value={opening.toFixed(2)} />
          <Stat label={closing !== null ? "Closed at" : "Now"} value={shown === null ? "-" : shown.toFixed(2)} sub={move === null ? undefined : signedPct(move)} subColor={toneOf(move)} />
          <PillStat label="Result">
            <Pill color={outcome.color} background={outcome.bg} size={30}>
              {outcome.label}
            </Pill>
          </PillStat>
        </div>
      </Frame>
    ),
    { ...OG_SIZE, fonts: ogFonts },
  );
}

/** Every stat's value sits in a box of the same height, so labels line up across the row. */
const VALUE_HEIGHT = 80;
const statLabel = { display: "flex", fontSize: 21, color: C.text3, letterSpacing: "0.08em", textTransform: "uppercase" } as const;

function Stat({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={statLabel}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, height: VALUE_HEIGHT }}>
        <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 76, lineHeight: 1 }}>{value}</div>
        {sub ? <div style={{ display: "flex", fontSize: 28, fontWeight: 500, color: subColor }}>{sub}</div> : null}
      </div>
    </div>
  );
}

function PillStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={statLabel}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", height: VALUE_HEIGHT }}>{children}</div>
    </div>
  );
}

const KIND_LABEL: Record<PnlShare["kind"], string> = { attention: "Attention perp", assetPerp: "Asset perp", outcome: "Outcome market", coin: "Trend coin" };

const fmtAmount = (v: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
const fmtLevel = (v: number) => (v >= 1000 ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v) : v >= 1 ? trimZeros(v, 3) : trimZeros(v, 4));

export function pnlImage(share: PnlShare | null, verified: boolean) {
  if (!share) {
    return new ImageResponse(
      (
        <Frame eyebrow="Result">
          <div style={{ display: "flex", marginTop: 72, fontFamily: DISPLAY, fontSize: 84 }}>Trade attention on Tredio</div>
        </Frame>
      ),
      { ...OG_SIZE, fonts: ogFonts },
    );
  }
  // Amounts count from a cent (percents from a tenth of a point, in toneOf).
  const tone = Math.abs(share.pnl) < 0.005 ? C.text3 : share.pnl > 0 ? C.up : C.down;
  const sign = share.pnl > 0 ? "+" : share.pnl < 0 ? "-" : "";
  return new ImageResponse(
    (
      <Frame
        eyebrow={KIND_LABEL[share.kind]}
        glow={share.pnl >= 0 ? C.up : C.down}
        footer={
          verified ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: C.up }}>
              <svg width={22} height={22} viewBox="0 0 24 24">
                <path d="M20 6 9 17l-5-5" fill="none" stroke={C.up} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Verified
            </div>
          ) : (
            "Attention markets"
          )
        }
      >
        <div style={{ display: "flex", marginTop: 40, fontSize: 32, color: C.text2, maxWidth: 1060 }}>{pnlHeadline(share)}</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginTop: 14 }}>
          <div style={{ display: "flex", fontFamily: DISPLAY, fontSize: 150, lineHeight: 0.95, color: tone, letterSpacing: "-0.02em" }}>
            {sign}
            {fmtAmount(share.pnl)}
          </div>
          <div style={{ display: "flex", fontSize: 34, color: C.text3, marginBottom: 14 }}>USDC</div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "flex-end", gap: 64, paddingBottom: 24 }}>
          {share.roi !== null ? (
            <PillStat label="Return">
              <Pill color={toneOf(share.roi)} background={softOf(share.roi)} size={32}>
                {signedPct(share.roi)}
              </Pill>
            </PillStat>
          ) : null}
          {share.entry !== null ? <Stat label="Entry" value={fmtLevel(share.entry)} /> : null}
          {share.exit !== null ? <Stat label="Exit" value={fmtLevel(share.exit)} /> : null}
        </div>
      </Frame>
    ),
    { ...OG_SIZE, fonts: ogFonts },
  );
}
