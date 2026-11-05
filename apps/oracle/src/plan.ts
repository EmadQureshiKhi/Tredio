import type { AssetClass, NewTrend, Report, Trend } from "@tredio/contracts";
import { toIndexUnits } from "./index-method";
import type { Measurement } from "./method";

/**
 * Which trends a run measures and what it reports, from what the registry holds and what the
 * collector measured. Pure, so it is tested without a chain.
 */

export const MAX_VERSION = 9;
export const ASSET_CLASSES: readonly AssetClass[] = ["crypto", "equity", "commodity", "fx", "person", "politics", "topic"];

export interface Candidate {
  /** Base identifier (`topic:openai`); a listing may carry a version (`topic:openai.2`). */
  identifier: string;
  surfacer: string | null;
  ticker: string | null;
  reviewHash: string | null;
  /** Kept by an admin: tried first, and crypto lists without smart-money inflow. */
  pinned: boolean;
  /** A community pick: tried right after kept topics, with every listing check. */
  pick: boolean;
}

export interface LiveTrend extends Trend {
  /** Registered series expiries at or before now: the next observation settles them. */
  pendingDue: number;
}

export const baseOf = (identifier: string) => identifier.replace(/\.([2-9])$/, "");
export const versioned = (base: string, n: number) => (n === 1 ? base : `${base}.${n}`);

export function assetClassOf(identifier: string): AssetClass {
  const prefix = identifier.split(":")[0] ?? "";
  return identifier.includes(":") && (ASSET_CLASSES as readonly string[]).includes(prefix) ? (prefix as AssetClass) : "topic";
}

/** A surfacer the curation contract can pay: a NEAR account (named with a dot, or implicit), else none. */
export function payableSurfacer(s: string | null): string | null {
  if (!s) return null;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)+([a-z\d]+[-_])*[a-z\d]+$/.test(s) || /^0u[a-z0-9]{50,62}$/.test(s) || /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/** The next free listing of a base identifier: the base, then `.2` to `.9` once earlier ones retired; null while one is live. */
export function freeListing(base: string, statusOf: (id: string) => Trend["status"] | null): string | null {
  for (let n = 1; n <= MAX_VERSION; n++) {
    const id = versioned(base, n);
    const status = statusOf(id);
    if (status === null) return id;
    if (status !== "retired") return null;
  }
  return null;
}

/**
 * The run's sample: trends whose series wait on a settlement observation first, then candidates
 * (while live slots are free), then the trends observed longest ago.
 */
export function allocate(live: readonly LiveTrend[], candidates: readonly Candidate[], slots: number, maxCandidates: number, freeSlots: number): { trends: LiveTrend[]; candidates: Candidate[] } {
  const pending = live.filter((t) => t.pendingDue > 0).sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id));
  const rest = live.filter((t) => t.pendingDue === 0).sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id));
  const trends = pending.slice(0, slots);
  const picked = freeSlots > 0 ? candidates.slice(0, Math.min(maxCandidates, freeSlots, slots - trends.length)) : [];
  trends.push(...rest.slice(0, slots - trends.length - picked.length));
  return { trends, candidates: picked };
}

export interface DecideParams {
  now: number;
  heartbeatSec: number;
  deviationBps: number;
  minCreateIndexPoints: number;
  minConfirmNetflowUsd: number;
  /** Hyperliquid perps listed on this network, for a crypto trend's `asset`. */
  hyperliquidAssets: ReadonlySet<string>;
}

/**
 * What to report: an update for a measured trend whose heartbeat is due, that moved at least
 * `deviationBps`, or that has a series waiting on its settlement observation; trends past half
 * their heartbeat ride along when a report goes out anyway. A candidate lists when its index is at
 * least `minCreateIndexPoints` and, for crypto, smart money is buying (or an admin kept it).
 */
export function decide(
  sampled: ReadonlyArray<{ trend: LiveTrend; m: Measurement }>,
  listings: ReadonlyArray<{ candidate: Candidate; identifier: string; m: Measurement }>,
  p: DecideParams,
): Pick<Report, "new_trends" | "updates"> {
  const updates: Report["updates"] = [];
  const riders: Report["updates"] = [];
  for (const { trend, m } of sampled) {
    if (m.points === null) continue;
    const index = Number(toIndexUnits(m.points));
    const age = p.now - trend.updated_at;
    const moved = trend.index > 0 ? (Math.abs(index - trend.index) * 10_000) / trend.index : Number.POSITIVE_INFINITY;
    if (age >= p.heartbeatSec || moved >= p.deviationBps || trend.pendingDue > 0) updates.push({ id: trend.id, index });
    else if (age >= p.heartbeatSec / 2) riders.push({ id: trend.id, index });
  }
  const newTrends: NewTrend[] = [];
  for (const { candidate: c, identifier, m } of listings) {
    if (m.points === null || m.points < p.minCreateIndexPoints) continue;
    const assetClass = assetClassOf(identifier);
    const crypto = assetClass === "crypto";
    const confirmed = c.pinned || (m.netflowUsd !== null && m.netflowUsd >= p.minConfirmNetflowUsd);
    if (crypto && !confirmed) continue;
    const ticker = c.ticker?.toUpperCase() ?? null;
    newTrends.push({
      identifier,
      asset_class: assetClass,
      index: Number(toIndexUnits(m.points)),
      surfacer: payableSurfacer(c.surfacer),
      smart_money_confirmed: crypto && confirmed,
      review_hash: c.reviewHash && /^[0-9a-f]{64}$/.test(c.reviewHash) ? c.reviewHash : null,
      asset: ticker && p.hyperliquidAssets.has(ticker) ? ticker : null,
    });
  }
  if (updates.length > 0 || newTrends.length > 0) updates.push(...riders);
  return { new_trends: newTrends, updates };
}
