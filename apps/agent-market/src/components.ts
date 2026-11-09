import { attentionPoints, type Component, normalizeCount, normalizeFlow, phasedWeight, seasonalFactor } from "@tredio/oracle/src/index-method";
import { METHOD, type Method, type Readings, type SourceName } from "@tredio/oracle/src/method";

/**
 * Each source's part of an attention index, by the oracle's own method (apps/oracle/src/method.ts,
 * documented in apps/oracle/docs/index-method.md): a reading becomes a component in [0, 1] (log
 * scale up to the source's saturation; Nansen's flow through tanh), and the index is the weighted
 * mean of the components that counted, times 100. A source's `points` is its term of that mean, so
 * the counted sources' points add up to the index. Hacker News is a boost: it counts only when it
 * would raise the index.
 */

export const SOURCE_INFO: Record<SourceName, { label: string; unit: string }> = {
  elfa: { label: "X and Telegram mentions (Elfa)", unit: "mentions in 24 h" },
  gdelt: { label: "News articles (GDELT)", unit: "articles in 24 h" },
  bluesky: { label: "Bluesky posts", unit: "posts in 24 h" },
  wikipedia: { label: "Wikipedia article views", unit: "views in a UTC day" },
  hn: { label: "Hacker News stories and comments (boost)", unit: "items in 24 h" },
  nansen: { label: "Smart-money net flow (Nansen, crypto only)", unit: "USD in 24 h" },
};

/** The order the oracle measures in: the count sources, then Nansen, then the Hacker News boost. */
export const SOURCE_ORDER: readonly SourceName[] = ["elfa", "gdelt", "wikipedia", "bluesky", "nansen", "hn"];

export interface SourceComponent {
  source: SourceName;
  label: string;
  unit: string;
  /** The raw reading, null when the source has none for this topic. */
  reading: number | null;
  windowSec: number | null;
  observedAt: number | null;
  /** Whether it entered the index; `reason` says why not. */
  counted: boolean;
  reason: string | null;
  /** Normalized value in [0, 1], null without a usable reading. */
  component: number | null;
  /** The method's weight for the source (0 when it did not count). */
  weight: number;
  /** Index points this source contributes; the counted sources add up to the index. */
  points: number;
  /** Its share of the index, 0 to 1. */
  share: number;
}

export interface Breakdown {
  /** Index points (0 to 100, two decimals) from these readings, null when no attention source counted. */
  points: number | null;
  sources: SourceComponent[];
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const hours = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`);

/** The breakdown of an index from the latest readings, measured at `atSec` (a reading past its source's age limit does not count). */
export function breakdown(readings: Readings, crypto: boolean, atSec: number, m: Method = METHOD): Breakdown {
  const rows = new Map<SourceName, SourceComponent & { raw: Component | null }>();
  const row = (source: SourceName, reason: string | null, raw: Component | null): void => {
    const r = readings[source];
    rows.set(source, {
      source,
      ...SOURCE_INFO[source],
      reading: r && Number.isFinite(r.value) ? r.value : null,
      windowSec: r?.windowSec ?? null,
      observedAt: r?.observedAt ?? null,
      counted: false,
      reason,
      component: raw ? round(raw.value, 4) : null,
      weight: 0,
      points: 0,
      share: 0,
      raw,
    });
  };
  // A usable reading: present, a number, and young enough; else why not.
  const usable = (source: SourceName, maxAgeSec: number): { value: number } | { reason: string } => {
    const r = readings[source];
    if (!r || !Number.isFinite(r.value)) return { reason: "no reading for this topic" };
    if (atSec - r.observedAt > maxAgeSec) return { reason: `reading older than ${hours(maxAgeSec)}` };
    return { value: r.value };
  };
  const hour = new Date(atSec * 1000).getUTCHours();
  const counted: Component[] = [];
  for (const source of ["elfa", "gdelt", "wikipedia", "bluesky"] as const) {
    const s = m[source];
    const u = usable(source, s.maxAgeSec);
    if ("reason" in u) {
      row(source, u.reason, null);
      continue;
    }
    const weight = phasedWeight(s.weight, s.phaseIn, atSec);
    const raw = { value: normalizeCount(u.value, s.clip, s.saturation, s.seasonality ? seasonalFactor(s.seasonality, hour) : 1), weight };
    if (weight <= 0) {
      row(source, "phased out", raw);
      continue;
    }
    row(source, null, raw);
    counted.push(raw);
  }
  // Smart money only shapes the index of a crypto topic, and only beside a real attention source.
  const flow = usable("nansen", m.nansen.maxAgeSec);
  if (!crypto) row("nansen", readings.nansen ? "counts for crypto topics only" : "no reading for this topic", null);
  else if ("reason" in flow) row("nansen", flow.reason, null);
  else if (counted.length === 0) row("nansen", "counts only beside an attention source", { value: normalizeFlow(flow.value, m.nansen.scaleUsd), weight: m.nansen.weight });
  else {
    const raw = { value: normalizeFlow(flow.value, m.nansen.scaleUsd), weight: m.nansen.weight };
    row("nansen", null, raw);
    counted.push(raw);
  }
  const base = attentionPoints(counted);
  // Hacker News: a boost, in only when its component is above the index without it.
  const hn = usable("hn", m.hn.maxAgeSec);
  if ("reason" in hn) row("hn", hn.reason, null);
  else {
    const weight = phasedWeight(m.hn.weight, m.hn.phaseIn, atSec);
    const raw = { value: normalizeCount(hn.value, m.hn.clip, m.hn.saturation, 1), weight };
    if (base === null) row("hn", "counts only beside an attention source", raw);
    else if (weight <= 0) row("hn", "phased out", raw);
    else if (raw.value * 100 <= base) row("hn", "a boost: below the index, so left out", raw);
    else {
      row("hn", null, raw);
      counted.push(raw);
    }
  }
  const total = counted.reduce((a, c) => a + c.weight, 0);
  const points = attentionPoints(counted);
  for (const r of rows.values()) {
    if (r.reason !== null || !r.raw || total <= 0 || points === null) continue;
    r.counted = true;
    r.weight = r.raw.weight;
    r.points = round((100 * Math.min(Math.max(r.raw.value, 0), 1) * r.raw.weight) / total, 2);
    r.share = points > 0 ? round(r.points / points, 4) : 0;
  }
  return {
    points: points === null ? null : round(points, 2),
    sources: SOURCE_ORDER.map((s) => {
      const { raw: _raw, ...r } = rows.get(s)!;
      return r;
    }),
  };
}
