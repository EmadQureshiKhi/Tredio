import type { Side } from "@tredio/autopilot";
import { type AccountVersion, bindsMarkToAssetIndex, hlMarkMaxAge } from "@tredio/contracts";
import { type ExchangeResponse, formatPrice, formatSize, type HlOrder, orderOutcome, type PerpMarket } from "@tredio/hyperliquid";

/**
 * Orders as the account contract accepts them, decided without any network: the worst price an
 * order may fill at, the exact strings Hyperliquid and the contract's guard read, the leverage an
 * opening sets, what the guard would refuse, and what Hyperliquid's answer means.
 */

/** The account contract's cap on session leverage changes (`HL_MAX_LEVERAGE`), as the backend enforces it on rules. */
export const SESSION_MAX_LEVERAGE = 10;
/**
 * The account's order guard: a session order's price is within 2% of the registry's mark
 * (`HL_MAX_DEVIATION_BPS`), a mark at most two minutes old on v1 account code and five on v2
 * (`hlMarkMaxAge`), which on v2 must also name the very asset index the order signs.
 */
export const GUARD_MAX_DEVIATION_BPS = 200n;
/** Time an order may take from this check to the guard's own, so a mark about to age out waits for the next one. */
export const GUARD_MARGIN_SEC = 20;
/** Hyperliquid refuses openings below this notional. */
export const MIN_ORDER_USD = 10;

/**
 * A mark as the registry's `mark_of` returns it: price with 8 decimals, observed at (unix seconds),
 * and the Hyperliquid asset index the oracle reported with it (absent from a registry deployed
 * before it stored one, null until the oracle reports it).
 */
export interface RegistryMark {
  price: string;
  at: number;
  asset_index?: number | null;
}

/** The order's direction on the exchange: openings trade the position's side, closes and reductions the other way. */
export const isBuy = (action: "open" | "close" | "reduce", side: Side) => (action === "open" ? side === "long" : side === "short");

/**
 * The worst price an order accepts: `slippageBps` from the mark against the order, or `bound` when
 * that is tighter (a copy's limit from the leader's fill).
 */
export function worstPrice(buy: boolean, mark: number, slippageBps: number, bound?: number): number {
  const s = slippageBps / 10_000;
  return buy ? Math.min(mark * (1 + s), bound ?? Number.POSITIVE_INFINITY) : Math.max(mark * (1 - s), bound ?? 0);
}

/**
 * The order the account contract signs: an immediate-or-cancel limit at the worst price. The price
 * rounds toward the mark (down for buys, up for sells), so it never accepts more than the slippage
 * and never strays further from the guard's mark; the size rounds down to the market's lot.
 */
export function buildOrder(market: Pick<PerpMarket, "symbol" | "index" | "szDecimals">, o: { buy: boolean; worstPrice: number; size: number; reduceOnly: boolean }): HlOrder | { skip: string } {
  if (!(o.size > 0) || !Number.isFinite(o.size)) return { skip: "nothing to trade" };
  if (!(o.worstPrice > 0) || !Number.isFinite(o.worstPrice)) return { skip: "no price" };
  const size = formatSize(o.size, market.szDecimals);
  if (!(Number(size) > 0)) return { skip: `${o.size} ${market.symbol} is below one lot (${10 ** -market.szDecimals})` };
  return {
    asset: market.symbol,
    asset_index: market.index,
    is_buy: o.buy,
    price: formatPrice(o.worstPrice, market.szDecimals, o.buy ? "down" : "up"),
    size,
    reduce_only: o.reduceOnly,
    tif: "Ioc",
  };
}

/** A decimal string as an integer with 8 decimals, as the contract's `parse_e8` reads it; null when it is not one. */
export function toE8(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]!) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
}

/**
 * What the account's order guard would refuse about an order, checked before paying for the
 * transaction: no mark; on v2 account code, a mark that does not name the asset index the order
 * signs (v2 refuses a mark without one too); a mark too old to last until the order lands (two
 * minutes on v1, five on v2); or a price more than 2% from the mark. Null when the guard will
 * accept it.
 */
export function guardProblem(asset: string, price: string, mark: RegistryMark | null, nowSec: number, order: { assetIndex: number; version: AccountVersion }): string | null {
  if (!mark) return `Tredio has no ${asset} mark yet, which the account's order guard needs`;
  if (bindsMarkToAssetIndex(order.version) && mark.asset_index !== order.assetIndex) {
    return mark.asset_index === null || mark.asset_index === undefined
      ? `Tredio's ${asset} mark does not name its Hyperliquid asset yet, which the account's order guard needs; orders wait for the oracle to report it`
      : `Tredio's ${asset} mark is for Hyperliquid asset ${mark.asset_index}, not the order's ${order.assetIndex}`;
  }
  const age = nowSec - mark.at;
  if (age > hlMarkMaxAge(order.version) - GUARD_MARGIN_SEC) return `Tredio's ${asset} mark is ${age}s old; orders wait for the oracle's next one`;
  const p = toE8(price);
  const m = BigInt(mark.price);
  if (p === null || p === 0n) return `bad price ${price}`;
  const diff = p > m ? p - m : m - p;
  if (diff * 10_000n > GUARD_MAX_DEVIATION_BPS * m) return `${price} is more than 2% from Tredio's ${asset} mark ${Number(m) / 1e8}`;
  return null;
}

/**
 * The leverage an opening sets on Hyperliquid: a whole number within the market's limit and the
 * venue's (an account's session may set at most 10x), at least 1.
 */
export function openingLeverage(requested: number, marketMax: number, venueMax: number): number {
  return Math.max(1, Math.floor(Math.min(requested, marketMax, venueMax) + 1e-9));
}

/**
 * The size that keeps a decision's margin at a lower leverage: margin times leverage over the
 * price, so a capped opening is smaller rather than more heavily margined.
 */
export const sizeAtLeverage = (size: number, requested: number, leverage: number) => (leverage < requested ? (size * leverage) / requested : size);

export type Outcome =
  | { status: "filled"; size: number; price: number; oid: number | null }
  | { status: "unfilled"; error: string }
  | { status: "failed"; error: string }
  /** Hyperliquid has seen this nonce: the order went out before, and its fills say how it ended. */
  | { status: "seen"; error: string };

/** What Hyperliquid's answer to an immediate-or-cancel order means. */
export function classify(r: ExchangeResponse): Outcome {
  const o = orderOutcome(r);
  if (o.ok) {
    if (o.filled && o.filled.totalSz > 0) return { status: "filled", size: o.filled.totalSz, price: o.filled.avgPx, oid: o.oid };
    return { status: "unfilled", error: o.oid !== null ? "the order rested instead of filling" : "Hyperliquid filled nothing" };
  }
  if (/could not immediately match/i.test(o.error)) return { status: "unfilled", error: o.error };
  if (/nonce/i.test(o.error)) return { status: "seen", error: o.error };
  return { status: "failed", error: o.error };
}
