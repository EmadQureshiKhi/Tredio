import { mentionsOf, usable } from "./queue";
import type { Candidate, Reading, SourceName } from "./store";

/**
 * What the app's "On the radar" shows for each approved candidate waiting for a live slot: the
 * signal that surfaced it, the attention the collector has measured so far, a sparkline and its
 * place in the oracle's queue. Built only from what the backend already stores.
 */

export interface RadarSignal {
  /** Where it came from, as a reader would say it ("Bluesky trending"). */
  label: string;
  /** The signal's own size when it has one (posts, views, mentions), else null. */
  count: number | null;
  unit: string | null;
}

/** The surfacing signal, from the candidate's source and the radar's stored signal. */
export function signalOf(c: Candidate): RadarSignal | null {
  const s = ((c.sourceRef as { signal?: Record<string, unknown> } | null)?.signal ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  switch (c.source) {
    case "bluesky_trend":
      return { label: "Bluesky trending", count: num(s.postCount), unit: "posts" };
    case "wikipedia_top":
      return { label: "Wikipedia most read", count: num(s.views), unit: "views" };
    case "elfa_trending":
      return { label: "Trending on X", count: num(s.mentions24h), unit: "mentions" };
    case "elfa_narrative":
      return { label: "X narrative", count: null, unit: null };
    case "coingecko_trending":
      return { label: "CoinGecko trending", count: null, unit: null };
    case "geckoterminal_trending":
      return { label: "GeckoTerminal trending", count: null, unit: null };
    case "link":
      return { label: "Proposed by a trader", count: null, unit: null };
    default:
      return null;
  }
}

export interface RadarReadings {
  /** Mentions in the last day on X's scale (Elfa, or Bluesky scaled), see `mentionsOf`. */
  mentions: number | null;
  bluesky: number | null;
  wikipedia: number | null;
  news: number | null;
  hn: number | null;
}

export function readingsOf(r: Partial<Record<SourceName, Reading>> | undefined, nowSec: number): RadarReadings {
  const read = (s: SourceName) => usable(r?.[s], s, nowSec);
  const mentions = mentionsOf(r, nowSec);
  return { mentions: mentions > 0 ? mentions : null, bluesky: read("bluesky"), wikipedia: read("wikipedia"), news: read("gdelt"), hn: read("hn") };
}

/** Sources a sparkline may draw, in preference order when they have as many points. */
const SPARK_SOURCES: readonly SourceName[] = ["elfa", "bluesky", "wikipedia"];
export const SPARK_HOURS = 48;
const SPARK_POINTS = 24;

/**
 * A sparkline of the last `SPARK_HOURS`: the source with the most readings, one point per bucket
 * (the bucket's last reading, carried forward over empty ones), and how far its last point is
 * above or below its first (percent), or null with fewer than two points.
 */
export function sparkOf(history: ReadonlyArray<{ source: SourceName; value: number; observedAt: number }>, nowSec: number): { spark: number[]; heating: number | null } {
  const by = new Map<SourceName, Array<{ value: number; observedAt: number }>>();
  for (const h of history) if (SPARK_SOURCES.includes(h.source)) by.set(h.source, [...(by.get(h.source) ?? []), h]);
  const source = [...SPARK_SOURCES].sort((a, b) => (by.get(b)?.length ?? 0) - (by.get(a)?.length ?? 0))[0]!;
  const points = by.get(source) ?? [];
  if (points.length === 0) return { spark: [], heating: null };
  const start = nowSec - SPARK_HOURS * 3600;
  const width = (SPARK_HOURS * 3600) / SPARK_POINTS;
  const buckets: Array<number | null> = Array.from({ length: SPARK_POINTS }, () => null);
  for (const p of points) {
    const i = Math.min(SPARK_POINTS - 1, Math.max(0, Math.floor((p.observedAt - start) / width)));
    buckets[i] = p.value;
  }
  const spark: number[] = [];
  let last: number | null = null;
  for (const b of buckets) {
    if (b !== null) last = b;
    if (last !== null) spark.push(last);
  }
  const first = spark[0];
  const end = spark.at(-1);
  const heating = spark.length >= 2 && first !== undefined && end !== undefined && first > 0 ? Math.round(((end - first) / first) * 1000) / 10 : null;
  return { spark: spark.map((v) => Math.round(v * 100) / 100), heating };
}

export { SPARK_SOURCES };
