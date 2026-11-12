import type { Persona, Style } from "./personas";

export type Rng = () => number;
export type Side = "up" | "down";

/** A live trend as the API lists it, with its newest listed series (null when none is on the book). */
export interface TrendView {
  identifier: string;
  displayName: string;
  /** Points, 0 to 100. */
  index: number;
  /** Percent over 24 hours. */
  change24h: number;
  series: number | null;
}

export interface Holding {
  series: number;
  trend: string;
  /** "open", or how it settled. */
  outcome: string;
  /** Outcome tokens, 6 decimals. */
  up: bigint;
  down: bigint;
}

export interface PerpPosition {
  id: number;
  trend: string;
  isLong: boolean;
  openedAt: number;
}

/** What a persona has and sees when it is its turn. */
export interface State {
  nowSec: number;
  /** USDC, 6 decimals. */
  usdc: bigint;
  trends: TrendView[];
  holdings: Holding[];
  positions: PerpPosition[];
  callsToday: number;
  /** Trends the persona already called today: one call a trend a day. */
  calledToday: string[];
  /** Another persona's open call it could answer in that trend's thread. */
  callToAnswer: { id: number; identifier: string; handle: string; direction: Side } | null;
}

export type Action =
  | { kind: "faucet" }
  | { kind: "redeem"; series: number; up: bigint; down: bigint }
  | { kind: "buy"; trend: TrendView; series: number; side: Side; amount: bigint }
  | { kind: "sell"; holding: Holding; side: Side; amount: bigint }
  | { kind: "perpOpen"; trend: TrendView; isLong: boolean; margin: bigint; leverageBps: number; acceptableIndex: number }
  | { kind: "perpClose"; position: PerpPosition; acceptableIndex: number }
  | { kind: "call"; trend: TrendView; direction: Side; horizonSec: 86_400 | 604_800 }
  | { kind: "post"; trend: TrendView; reply: State["callToAnswer"] };

export const USDC = 1_000_000n;
/** Index units: 1e6 is one point. */
const POINT = 1_000_000;
const FAUCET_BELOW = 30n * USDC;
const MAX_PERPS = 3;
const MAX_CALLS_A_DAY = 3;
/** A perp is held at least this long before its persona may close it. */
const MIN_PERP_HOLD_SEC = 3_600;

const WEIGHTS: Record<Style, Record<"buy" | "sell" | "perpOpen" | "perpClose" | "call" | "post", number>> = {
  momentum: { buy: 4, sell: 1.5, perpOpen: 2, perpClose: 1.5, call: 1.5, post: 1 },
  contrarian: { buy: 3, sell: 2, perpOpen: 2, perpClose: 1.5, call: 2, post: 1.5 },
  perps: { buy: 1, sell: 0.5, perpOpen: 4, perpClose: 3, call: 1, post: 1 },
  caller: { buy: 1.5, sell: 0.5, perpOpen: 0.5, perpClose: 0.5, call: 4, post: 3.5 },
  swing: { buy: 2.5, sell: 1, perpOpen: 1.5, perpClose: 0.7, call: 1.5, post: 1 },
};

/** Whether it is between 08:00 and midnight where the persona lives. */
export function isAwake(p: Pick<Persona, "utcOffset">, nowSec: number): boolean {
  const hour = (((nowSec / 3600 + p.utcOffset) % 24) + 24) % 24;
  return hour >= 8;
}

/** One pick from weighted options; null when every weight is zero. */
export function weighted<T>(options: readonly (readonly [T, number])[], rng: Rng): T | null {
  const total = options.reduce((s, [, w]) => s + Math.max(0, w), 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const [v, w] of options) {
    r -= Math.max(0, w);
    if (r < 0) return v;
  }
  return options[options.length - 1]![0];
}

const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
/** A USDC amount between lo and hi, in steps of half a dollar. */
const usdcBetween = (rng: Rng, lo: number, hi: number) => (BigInt(Math.round(between(rng, lo, hi) * 2)) * USDC) / 2n;

/** The side a persona takes on a trend: its style read against the last day's move, with some noise. */
export function sideFor(style: Style, t: TrendView, rng: Rng): Side {
  const rising: Side = t.change24h >= 0 ? "up" : "down";
  const falling: Side = rising === "up" ? "down" : "up";
  const follow = style === "momentum" ? 0.8 : style === "contrarian" ? 0.25 : 0.55;
  return rng() < follow ? rising : falling;
}

/** Hotter trends draw more attention, but every live trend gets some. */
export function pickTrend(trends: readonly TrendView[], rng: Rng, needSeries = false): TrendView | null {
  const pool = trends.filter((t) => !needSeries || t.series !== null);
  return weighted(pool.map((t) => [t, 10 + t.index] as const), rng);
}

/** The persona's next action, or null when nothing it may do fits. */
export function nextAction(p: Pick<Persona, "style">, s: State, rng: Rng): Action | null {
  if (s.usdc < FAUCET_BELOW) return { kind: "faucet" };
  const settled = s.holdings.find((h) => h.outcome !== "open" && (h.up > 0n || h.down > 0n));
  if (settled) return { kind: "redeem", series: settled.series, up: settled.up, down: settled.down };

  const w = WEIGHTS[p.style];
  const open = s.holdings.filter((h) => h.outcome === "open" && (h.up > 0n || h.down > 0n));
  const closable = s.positions.filter((x) => s.nowSec - x.openedAt >= MIN_PERP_HOLD_SEC);
  const withSeries = s.trends.some((t) => t.series !== null);
  const uncalled = s.trends.filter((t) => !s.calledToday.includes(t.identifier));
  const kind = weighted(
    [
      ["buy", withSeries ? w.buy : 0],
      ["sell", open.length > 0 ? w.sell : 0],
      ["perpOpen", s.positions.length < MAX_PERPS && s.trends.length > 0 ? w.perpOpen : 0],
      ["perpClose", closable.length > 0 ? w.perpClose : 0],
      ["call", s.callsToday < MAX_CALLS_A_DAY && uncalled.length > 0 ? w.call : 0],
      ["post", s.trends.length > 0 ? w.post : 0],
    ] as const,
    rng,
  );
  const small = p.style === "caller";
  switch (kind) {
    case "buy": {
      const t = pickTrend(s.trends, rng, true)!;
      return { kind: "buy", trend: t, series: t.series!, side: sideFor(p.style, t, rng), amount: small ? usdcBetween(rng, 2, 8) : usdcBetween(rng, 4, 30) };
    }
    case "sell": {
      const h = open[Math.floor(rng() * open.length)]!;
      const side: Side = h.up >= h.down ? "up" : "down";
      const held = side === "up" ? h.up : h.down;
      // Half to all of the position, kept a whole number of micro-units.
      return { kind: "sell", holding: h, side, amount: (held * BigInt(Math.round(between(rng, 0.5, 1) * 100))) / 100n };
    }
    case "perpOpen": {
      const t = pickTrend(s.trends, rng)!;
      const isLong = sideFor(p.style, t, rng) === "up";
      const leverageBps = weighted([[10_000, 3], [15_000, 3], [20_000, 2], [30_000, 1]] as const, rng)!;
      // Up to 3% worse than the index now, and never past the index's bounds.
      const acceptableIndex = Math.round((isLong ? Math.min(100, t.index * 1.03) : Math.max(0, t.index * 0.97)) * POINT);
      return { kind: "perpOpen", trend: t, isLong, margin: small ? usdcBetween(rng, 2, 6) : usdcBetween(rng, 3, 20), leverageBps, acceptableIndex };
    }
    case "perpClose": {
      const x = closable.reduce((a, b) => (b.openedAt < a.openedAt ? b : a));
      return { kind: "perpClose", position: x, acceptableIndex: x.isLong ? 0 : 100 * POINT };
    }
    case "call": {
      const t = pickTrend(uncalled, rng)!;
      return { kind: "call", trend: t, direction: sideFor(p.style, t, rng), horizonSec: rng() < 0.8 ? 86_400 : 604_800 };
    }
    case "post": {
      const answer = s.callToAnswer && rng() < 0.6 ? s.callToAnswer : null;
      const t = answer ? (s.trends.find((x) => x.identifier === answer.identifier) ?? pickTrend(s.trends, rng)!) : pickTrend(s.trends, rng)!;
      return { kind: "post", trend: t, reply: answer && answer.identifier === t.identifier ? answer : null };
    }
    default:
      return null;
  }
}
