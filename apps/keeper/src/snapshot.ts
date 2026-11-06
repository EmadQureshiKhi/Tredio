import type { Viewer } from "@tredio/chain";
import type { Curve, Deployment, Depth, Market, PerpMarket, Position, PositionState, RegistryParams, Series, Trend } from "@tredio/contracts";

/** Everything the keeper decides from, read in one pass. */
export interface Snapshot {
  now: number;
  params: RegistryParams;
  windows: number[];
  trends: Trend[];
  /** The latest series per live trend and window (null: none opened yet). */
  latest: Array<{ trend: string; window: number; series: Series | null }>;
  /** Expired open series whose settlement value the registry already holds. */
  settleable: Set<number>;
  /** Open series whose book markets are missing. */
  unlisted: number[];
  /** Expired series that still have book markets (resting orders to clear). */
  expiredMarkets: Array<{ series: number; side: "up" | "down" }>;
  positions: Array<Position & { state: PositionState | null }>;
  perpMarkets: Array<{ trend: string; market: PerpMarket }>;
  curves: Curve[];
}

const PAGE = 100;
/** The outcomes contract voids a series this long after expiry when no settlement came (`VOID_GRACE`). */
export const VOID_GRACE_SEC = 2 * 86_400;

async function pages<T>(read: (from: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await read(from);
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

export async function snapshot(v: Viewer, d: Deployment, nowSec: number): Promise<Snapshot> {
  const c = d.contracts;
  const [params, windows, trends, positions, curves] = await Promise.all([
    v.view<RegistryParams>(c.registry, "get_params"),
    v.view<number[]>(c.outcomes, "windows"),
    pages((from) => v.view<Trend[]>(c.registry, "get_trends", { from_index: from, limit: PAGE })),
    pages((from) => v.view<Position[]>(c.perps, "get_positions", { from_index: from, limit: PAGE })),
    pages((from) => v.view<Curve[]>(c.coins, "get_curves", { from_index: from, limit: PAGE })),
  ]);
  const live = trends.filter((t) => t.status !== "retired");
  const latest = (
    await Promise.all(
      live.flatMap((t) => windows.map(async (window) => ({ trend: t.id, window, series: await v.view<Series | null>(c.outcomes, "latest_series", { trend: t.id, window }) }))),
    )
  ).flat();
  // An expired series settles once the registry holds its value (or, past the void grace, as void).
  const expiredOpen = latest.flatMap((l) => (l.series && l.series.outcome === "open" && nowSec >= l.series.expiry ? [l.series] : []));
  const settlements = await Promise.all(
    expiredOpen.map((s) => v.view<{ finalized: boolean }>(c.registry, "settlement_of", { id: s.trend, expiry: s.expiry }).catch(() => ({ finalized: false }))),
  );
  const settleable = new Set(expiredOpen.filter((s, i) => settlements[i]!.finalized || nowSec >= s.expiry + VOID_GRACE_SEC).map((s) => s.id));
  // Series still open or expired and unsettled: their book markets.
  const recent = latest.flatMap((l) => (l.series ? [l.series] : []));
  const markets = await Promise.all(
    recent.map(async (s) => ({ s, up: await v.view<Market | null>(c.book, "get_market", { series: s.id, side: "up" }) })),
  );
  const unlisted = markets.filter((m) => !m.up && m.s.outcome === "open" && nowSec < m.s.expiry).map((m) => m.s.id);
  // Expired markets with orders still resting: one depth read per side, so an empty book costs no transaction.
  const expired = markets.filter((m) => m.up && nowSec >= m.s.expiry).flatMap((m) => (["up", "down"] as const).map((side) => ({ series: m.s.id, side })));
  const depths = await Promise.all(expired.map((e) => v.view<Depth>(c.book, "depth", { series: e.series, side: e.side, levels: 1 }).catch(() => null)));
  const expiredMarkets = expired.filter((_, i) => (depths[i]?.bids.length ?? 0) + (depths[i]?.asks.length ?? 0) > 0);
  const states = await Promise.all(positions.map((p) => v.view<PositionState>(c.perps, "position_state", { id: p.id, index: null }).catch(() => null)));
  const perpTrends = [...new Set(positions.map((p) => p.trend))];
  const perpMarkets = await Promise.all(perpTrends.map(async (trend) => ({ trend, market: await v.view<PerpMarket>(c.perps, "get_market", { trend }) })));
  return {
    now: nowSec,
    params,
    windows,
    trends,
    latest,
    settleable,
    unlisted,
    expiredMarkets,
    positions: positions.map((p, i) => ({ ...p, state: states[i] ?? null })),
    perpMarkets,
    curves,
  };
}
