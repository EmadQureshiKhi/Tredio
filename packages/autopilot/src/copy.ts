import { z } from "zod";
import type { Side } from "./rules";

/**
 * Copy-trading. A leader's asset perp positions are snapshotted per market; each change (open,
 * increase, decrease, close, flip) becomes an order for every follower, sized by the follower's
 * own settings and capped by them. Diffing positions mirrors manual trades and Autopilot trades
 * alike, and a missed snapshot never double-counts: the next diff starts from what the follower
 * holds.
 *
 * A leader can see when and at what limit followers trade, so a copied opening never pays more
 * than the follower's slippage from both the leader's own fill and the mark, and is skipped once
 * the market has moved further. Open losses count against the daily loss limit, and a follow whose
 * open copies lose its loss cap is closed out and paused.
 */

export interface Holding {
  side: Side;
  /** Size in the market's unit. */
  size: number;
  /** Margin posted, USDC. */
  marginUsdc: number;
  /** Average entry price, when known. */
  entryPrice?: number | null;
}

/** `price` on openings is the leader's own fill, when the snapshots show it. */
export type Change =
  | { kind: "open"; market: string; side: Side; size: number; leverage: number; price?: number }
  | { kind: "increase"; market: string; side: Side; size: number; leverage: number; price?: number }
  | { kind: "decrease"; market: string; side: Side; fraction: number }
  | { kind: "close"; market: string; side: Side };

/** Leverage implied by a holding at `price`. */
const leverageOf = (h: Holding, price: number) => (h.marginUsdc > 0 ? (h.size * price) / h.marginUsdc : 1);
const positive = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/** The price the size added between two holdings filled at, from their average entries. */
function addedAt(before: Holding, after: Holding): number | undefined {
  if (!positive(before.entryPrice) || !positive(after.entryPrice)) return undefined;
  const fill = (after.entryPrice * after.size - before.entryPrice * before.size) / (after.size - before.size);
  return positive(fill) ? fill : undefined;
}
const withPrice = <T extends object>(c: T, price: number | null | undefined): T & { price?: number } => (positive(price) ? { ...c, price } : c);

/** What changed in one market between two snapshots of a leader. */
export function diffHolding(market: string, before: Holding | null, after: Holding | null, price: number): Change[] {
  const eps = 1e-12;
  if (!before && !after) return [];
  if (!before && after) return [withPrice({ kind: "open" as const, market, side: after.side, size: after.size, leverage: leverageOf(after, price) }, after.entryPrice)];
  if (before && !after) return [{ kind: "close", market, side: before.side }];
  const b = before!;
  const a = after!;
  if (a.side !== b.side) {
    return [{ kind: "close", market, side: b.side }, withPrice({ kind: "open" as const, market, side: a.side, size: a.size, leverage: leverageOf(a, price) }, a.entryPrice)];
  }
  if (a.size > b.size + eps) return [withPrice({ kind: "increase" as const, market, side: a.side, size: a.size - b.size, leverage: leverageOf(a, price) }, addedAt(b, a))];
  if (a.size < b.size - eps) return [{ kind: "decrease", market, side: a.side, fraction: 1 - a.size / b.size }];
  return [];
}

/** Slippage a copied opening may take when a follow does not say. */
export const DEFAULT_COPY_SLIPPAGE_PCT = 0.3;
/**
 * The most a copy may take. Session orders on asset perps must be priced within 2% of the market's
 * mark (the account's order guard), so a limit of at most 1% from the mark leaves room for the mark to move
 * between reading it and the order landing. Follows stored with more are held to this.
 */
export const MAX_COPY_SLIPPAGE_PCT = 1;

/**
 * A follower's settings, as the API accepts them. The passkey approves them exactly as sent, and
 * what is stored follows from them (defaults filled in).
 */
export const followSettingsSchema = z
  .object({
    /** ratio: the leader's size times `ratio`; fixed: `fixedMarginUsdc` per opening trade. */
    mode: z.enum(["ratio", "fixed"]),
    ratio: z.number().positive().max(10).default(1),
    fixedMarginUsdc: z.number().nonnegative().max(1_000_000).default(0),
    /** Largest margin per position, USDC. */
    maxMarginUsdc: z.number().positive().max(1_000_000),
    /** Highest leverage to copy; higher leader leverage is reduced to this, and to the market's cap (MirrorContext). */
    maxLeverage: z.number().min(1).max(20).default(3),
    /** Stop opening copies for the rest of the UTC day once realized and open losses reach this. */
    maxDailyLossUsdc: z.number().positive().max(1_000_000),
    /** Worst fill for a copied opening, percent from the leader's fill and from the mark (the tighter wins). */
    maxSlippagePct: z.number().min(0.05).max(MAX_COPY_SLIPPAGE_PCT).default(DEFAULT_COPY_SLIPPAGE_PCT),
    /** Close every open copy and pause the follow once they are down this much together, USDC. Defaults to the daily loss limit. */
    maxOpenLossUsdc: z.number().positive().max(1_000_000).optional(),
  })
  .refine((s) => s.mode !== "fixed" || s.fixedMarginUsdc > 0, { message: "fixed mode needs a margin per trade", path: ["fixedMarginUsdc"] })
  .transform((s) => ({ ...s, maxOpenLossUsdc: s.maxOpenLossUsdc ?? s.maxDailyLossUsdc }));

export type FollowSettings = z.output<typeof followSettingsSchema>;
export type FollowSettingsInput = z.input<typeof followSettingsSchema>;

/** Settings stored before slippage and the loss cap existed, with what they now default to. */
export function withFollowDefaults(s: Omit<FollowSettings, "maxSlippagePct" | "maxOpenLossUsdc"> & Partial<FollowSettings>): FollowSettings {
  return { ...s, maxSlippagePct: s.maxSlippagePct ?? DEFAULT_COPY_SLIPPAGE_PCT, maxOpenLossUsdc: s.maxOpenLossUsdc ?? s.maxDailyLossUsdc };
}

/** PnL of open positions at the mark, USDC, fees and funding aside; one with no mark or entry yet counts as flat. */
export function openPnl(positions: ReadonlyArray<{ market: string; side: Side; size: number; entryPrice: number | null }>, marks: ReadonlyMap<string, number>): number {
  let pnl = 0;
  for (const p of positions) {
    const mark = marks.get(p.market);
    if (!positive(mark) || !positive(p.entryPrice)) continue;
    pnl += (p.side === "long" ? mark - p.entryPrice : p.entryPrice - mark) * p.size;
  }
  return pnl;
}

/** True once a follow's open copies are down its loss cap. */
export const lossCapReached = (f: FollowSettings, openPnlUsdc: number) => openPnlUsdc <= -f.maxOpenLossUsdc;

/**
 * The worst price a copied opening may fill at: `slippagePct` from the mark and from the leader's
 * fill, whichever is tighter, and never more than MAX_COPY_SLIPPAGE_PCT. A leader resting orders
 * at the follower's limit gains at most that, and cannot widen it by filling at an off-market price.
 * Once the mark is already past the limit from the leader's fill, the copy would only chase them: it
 * is skipped with the reason.
 */
export function copyLimit(side: Side, mark: number, leaderFill: number | undefined, requestedPct: number): { worstPrice: number } | { skip: string } {
  const slippagePct = Math.min(requestedPct, MAX_COPY_SLIPPAGE_PCT);
  const s = slippagePct / 100;
  const dir = side === "long" ? 1 : -1;
  const fromMark = mark * (1 + dir * s);
  if (!positive(leaderFill)) return { worstPrice: fromMark };
  const fromLeader = leaderFill * (1 + dir * s);
  if (dir * (mark - fromLeader) > 0) {
    const moved = (dir * (mark - leaderFill) * 100) / leaderFill;
    return { skip: `the price moved ${moved.toFixed(2)}% from the leader's fill, past your ${slippagePct}% limit` };
  }
  return { worstPrice: dir > 0 ? Math.min(fromMark, fromLeader) : Math.max(fromMark, fromLeader) };
}

export type MirrorOrder =
  | { action: "open"; market: string; side: Side; size: number; leverage: number; marginUsdc: number; worstPrice: number }
  | { action: "reduce"; market: string; side: Side; size: number }
  | { action: "skip"; market: string; reason: string };

/** Where a follow stands when a change is copied. */
export interface MirrorContext {
  /** The market's mark price now. */
  price: number;
  /** Realized PnL of the follow's copies today (UTC), USDC. */
  realizedTodayUsdc: number;
  /** PnL of the follow's open copies at the mark, USDC. */
  openPnlUsdc: number;
  /**
   * The most leverage the follower can open at: the market's limit and, for an account, its
   * session's cap (the account's order guard refuses more). Copies above it are reduced to it.
   */
  maxLeverage: number;
}

/**
 * The follower's order for one leader change, given what the follower holds in that market now.
 * Reductions and closes always copy, so a follower is never left holding the leader's exit.
 */
export function mirror(change: Change, f: FollowSettings, held: Holding | null, at: MirrorContext): MirrorOrder {
  const market = change.market;
  if (change.kind === "close" || change.kind === "decrease") {
    if (!held || held.side !== change.side) return { action: "skip", market, reason: "the follower holds no matching position" };
    const fraction = change.kind === "close" ? 1 : change.fraction;
    return { action: "reduce", market, side: held.side, size: held.size * fraction };
  }
  if (at.realizedTodayUsdc + at.openPnlUsdc <= -f.maxDailyLossUsdc) return { action: "skip", market, reason: "daily loss limit reached" };
  if (lossCapReached(f, at.openPnlUsdc)) return { action: "skip", market, reason: "open copies are at the loss cap" };
  if (held && held.side !== change.side) return { action: "skip", market, reason: "the follower holds the opposite side" };
  const price = at.price;
  if (!(price > 0)) return { action: "skip", market, reason: "no price" };
  const limit = copyLimit(change.side, price, change.price, f.maxSlippagePct);
  if ("skip" in limit) return { action: "skip", market, reason: limit.skip };
  const leverage = Math.max(1, Math.min(change.leverage, f.maxLeverage, at.maxLeverage));
  let margin = f.mode === "ratio" ? (change.size * f.ratio * price) / leverage : change.kind === "open" ? f.fixedMarginUsdc : 0;
  const room = f.maxMarginUsdc - (held?.marginUsdc ?? 0);
  margin = Math.min(margin, room);
  if (margin <= 0) return { action: "skip", market, reason: change.kind === "increase" && f.mode === "fixed" ? "fixed size copies openings only" : "position cap reached" };
  return { action: "open", market, side: change.side, size: (margin * leverage) / price, leverage, marginUsdc: margin, worstPrice: limit.worstPrice };
}
