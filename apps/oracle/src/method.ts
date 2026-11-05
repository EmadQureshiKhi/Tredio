import { boostedPoints, type Component, normalizeCount, normalizeFlow, phasedWeight, seasonalFactor } from "./index-method";

/**
 * The index method's parameters (docs/index-method.md) and the measurement of one trend from the
 * collector's latest readings. A reading older than its source's `maxAgeSec` is ignored, so a
 * stalled collector removes a component instead of freezing the index.
 */

export interface CountSource {
  weight: number;
  clip: number;
  saturation: number;
  maxAgeSec: number;
  /** Hourly profile (24 values); flat for day-long measurements. */
  seasonality?: number[];
  phaseIn?: { fromSec: number; durationSec: number };
}

export interface Method {
  elfa: CountSource;
  bluesky: CountSource;
  gdelt: CountSource;
  wikipedia: CountSource;
  /** A boost: it enters only when it raises the index. */
  hn: CountSource;
  nansen: { weight: number; scaleUsd: number; maxAgeSec: number; minConfirmNetflowUsd: number };
}

export const METHOD: Method = {
  elfa: { weight: 0.6, clip: 10_000, saturation: 5_000, maxAgeSec: 43_200 },
  bluesky: { weight: 0.35, clip: 10_000, saturation: 1_000, maxAgeSec: 7_200 },
  gdelt: { weight: 0.3, clip: 20_000, saturation: 3_000, maxAgeSec: 7_200 },
  wikipedia: { weight: 0.25, clip: 5_000_000, saturation: 150_000, maxAgeSec: 172_800 },
  hn: { weight: 0.15, clip: 5_000, saturation: 300, maxAgeSec: 10_800 },
  nansen: { weight: 0.2, scaleUsd: 500_000, maxAgeSec: 43_200, minConfirmNetflowUsd: 100_000 },
};

export type SourceName = "elfa" | "bluesky" | "gdelt" | "wikipedia" | "hn" | "nansen";

/** One source's latest reading as the backend's /v1/oracle/measurements reports it. */
export interface Reading {
  value: number;
  windowSec: number;
  /** Unix seconds. */
  observedAt: number;
}

export type Readings = Partial<Record<SourceName, Reading | null>>;

export interface Measurement {
  /** Index points (0 to 100), or null when no attention source answered. */
  points: number | null;
  /** Net smart-money flow (USD, 24 h) for crypto, or null. */
  netflowUsd: number | null;
  /** Which sources counted, for the run log. */
  sources: SourceName[];
}

const fresh = (r: Reading | null | undefined, now: number, maxAge: number) => (r && Number.isFinite(r.value) && now - r.observedAt <= maxAge ? r.value : null);

export function measure(readings: Readings, crypto: boolean, observedAt: number, m: Method = METHOD): Measurement {
  const hour = new Date(observedAt * 1000).getUTCHours();
  const components: Component[] = [];
  const sources: SourceName[] = [];
  const count = (name: Exclude<SourceName, "nansen" | "hn">) => {
    const s = m[name];
    const x = fresh(readings[name], observedAt, s.maxAgeSec);
    const weight = phasedWeight(s.weight, s.phaseIn, observedAt);
    if (x === null || weight <= 0) return;
    components.push({ value: normalizeCount(x, s.clip, s.saturation, s.seasonality ? seasonalFactor(s.seasonality, hour) : 1), weight });
    sources.push(name);
  };
  count("elfa");
  count("gdelt");
  count("wikipedia");
  count("bluesky");
  // Smart money only shapes the index alongside real attention measurements.
  const flow = crypto ? fresh(readings.nansen, observedAt, m.nansen.maxAgeSec) : null;
  if (flow !== null && components.length > 0) {
    components.push({ value: normalizeFlow(flow, m.nansen.scaleUsd), weight: m.nansen.weight });
    sources.push("nansen");
  }
  // Hacker News only lifts an index: most topics never reach it, and its silence is no signal.
  const boosts: Component[] = [];
  const hn = fresh(readings.hn, observedAt, m.hn.maxAgeSec);
  const hnWeight = phasedWeight(m.hn.weight, m.hn.phaseIn, observedAt);
  if (hn !== null && hnWeight > 0) boosts.push({ value: normalizeCount(hn, m.hn.clip, m.hn.saturation, 1), weight: hnWeight });
  const points = boostedPoints(components, boosts);
  if (points !== null && boosts.length > 0 && boosts[0]!.value * 100 > (boostedPoints(components, []) ?? 0)) sources.push("hn");
  return { points: points === null ? null : Math.round(points * 100) / 100, netflowUsd: flow, sources };
}
