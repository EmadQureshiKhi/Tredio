import type { ChainTrend } from "./chain";
import { baseOf } from "./identifiers";
import { mentionsOf } from "./queue";
import type { Candidate, Reading, SourceName } from "./store";

/**
 * Rotation: when every live slot is taken and approved candidates are waiting, a trend whose
 * attention has faded makes room for a stronger one. The backend picks it; the oracle stops
 * updating it (it reads the rotating list with its queue), so the registry retires it as stale
 * after `staleRetireWindow`, its open rounds settle at its last index, and its slot lists the queue
 * at once. One rotation runs at a time.
 */

export interface RotationRules {
  /** Live slots, equal to the oracle's `discovery.maxLiveTrends`. */
  maxLive: number;
  /** A trend is live at least this long before it can rotate out. */
  minAgeSec: number;
  /** A trend rotates out only at or below this fraction of its own peak index. */
  fadeRatio: number;
}

export interface RotationPick {
  trend: ChainTrend;
  replacement: Candidate;
  reason: string;
}

const LIVE = new Set(["Active", "Cooling"]);

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * The trend to rotate out now, or null. Every condition must hold: the board is full, nothing is
 * already cooling (its slot frees by itself), and the trend is not pinned, has been live at least
 * `minAgeSec`, sits at or below `fadeRatio` of its peak and below the median of the live trends,
 * and draws fewer mentions than the strongest candidate ready to list. The weakest qualifying
 * trend goes first.
 */
export function pickRotation(
  trends: readonly ChainTrend[],
  ready: readonly Candidate[],
  latest: ReadonlyMap<string, Partial<Record<SourceName, Reading>>>,
  pins: ReadonlySet<string>,
  rules: RotationRules,
  nowSec: number,
): RotationPick | null {
  const live = trends.filter((t) => LIVE.has(t.status));
  if (live.length < rules.maxLive || ready.length === 0) return null;
  if (live.some((t) => t.status === "Cooling")) return null;
  const strongest = ready.reduce((best, c) => (mentionsOf(latest.get(c.identifier), nowSec) > mentionsOf(latest.get(best.identifier), nowSec) ? c : best));
  const strength = mentionsOf(latest.get(strongest.identifier), nowSec);
  const mid = median(live.map((t) => t.index));
  const eligible = live
    .filter((t) => !pins.has(baseOf(t.identifier)))
    .filter((t) => nowSec - t.createdAt >= rules.minAgeSec)
    .filter((t) => t.peakIndex > 0 && t.index <= rules.fadeRatio * t.peakIndex)
    .filter((t) => t.index < mid)
    .map((t) => ({ t, mentions: mentionsOf(latest.get(baseOf(t.identifier)), nowSec) }))
    .filter((x) => x.mentions < strength)
    .sort((a, b) => a.t.index - b.t.index || a.mentions - b.mentions || a.t.identifier.localeCompare(b.t.identifier));
  const pick = eligible[0];
  if (!pick) return null;
  const pct = Math.round((pick.t.index / pick.t.peakIndex) * 100);
  return {
    trend: pick.t,
    replacement: strongest,
    reason: `faded to ${pick.t.index.toFixed(1)} (${pct}% of its ${pick.t.peakIndex.toFixed(1)} peak, median ${mid.toFixed(1)}); ${strongest.identifier} draws ${Math.round(strength)} mentions to its ${Math.round(pick.mentions)}`,
  };
}

/**
 * The oracle's queue with the running rotation's replacement first, so the trend that takes the
 * freed slot is the one the rotation named. Kept topics and community picks still go before it:
 * the oracle tries those first whatever the order.
 */
export function replacementFirst<T extends { identifier: string }>(queue: readonly T[], replacement: string | null | undefined): T[] {
  const i = replacement ? queue.findIndex((c) => c.identifier === replacement) : -1;
  return i <= 0 ? [...queue] : [queue[i]!, ...queue.slice(0, i), ...queue.slice(i + 1)];
}
