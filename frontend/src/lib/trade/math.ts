/**
 * The numbers behind the tickets, mirroring the contracts so what a ticket shows before confirming
 * is what the chain does: the book's fills and fee, the anchored band, the perps' fee, size,
 * liquidation and funding.
 *
 * Units: USDC and outcome tokens 6 decimals; the index 6 decimals (1e6 = one point); book prices
 * in ticks of 0.001 USDC (1 to 999) and sizes in lots of 0.001 token (1000 raw); perp qty 18
 * decimals, 1e18 qty moving 1 USDC per index point.
 */

export const USDC = 1_000_000n;
export const LOT = 1_000n;
export const INDEX_SCALE = 1_000_000;
const WAD = 10n ** 18n;
const BPS = 10_000n;

/** Index points to the registry's raw units. */
export const indexRaw = (points: number) => Math.round(points * INDEX_SCALE);

export interface Level {
  tick: number;
  /** Raw tokens resting at the tick. */
  size: bigint;
}

export interface BookSide {
  bids: Level[];
  asks: Level[];
}

/** USDC (raw) for `size` tokens (raw) at `tick`, as the book computes it. */
export const cost = (size: bigint, tick: number) => (size / LOT) * BigInt(tick);
const feeOn = (usdc: bigint, feeBps: bigint) => (usdc * feeBps) / BPS;

export interface Quote {
  /** Tokens out (buys) or USDC out after the fee (sells), raw. */
  out: bigint;
  /** USDC spent including the fee (buys) or tokens sold (sells), raw. */
  filled: bigint;
  /** True when the book (within the limit) takes the whole amount. */
  complete: boolean;
  /** USDC per token, fee included. */
  averagePrice: number;
  /** The last tick it would trade at. */
  worstTick: number | null;
}

/** Tokens that `budget` USDC (fee included) buys from the asks, up to `limitTick`, as the book fills it. */
export function quoteBuy(book: BookSide, budget: bigint, feeBps: bigint, limitTick = 999): Quote {
  let left = budget;
  let size = 0n;
  let worstTick: number | null = null;
  // True once the budget, not the book, is what stopped the fill.
  let spentOut = false;
  for (const level of book.asks) {
    if (level.tick > limitTick) break;
    let lots = (left * BPS) / (BigInt(level.tick) * (BPS + feeBps));
    while (lots > 0n && cost(lots * LOT, level.tick) + feeOn(cost(lots * LOT, level.tick), feeBps) > left) lots -= 1n;
    const available = level.size - (level.size % LOT);
    const take = available < lots * LOT ? available : lots * LOT;
    if (take <= 0n) {
      spentOut = lots === 0n;
      break;
    }
    const usdc = cost(take, level.tick);
    left -= usdc + feeOn(usdc, feeBps);
    size += take;
    worstTick = level.tick;
    if (take < available) {
      spentOut = true;
      break;
    }
  }
  const spent = budget - left;
  const tokens = Number(size) / 1e6;
  return { out: size, filled: spent, complete: size > 0n && (spentOut || left * 1000n < budget), averagePrice: tokens > 0 ? Number(spent) / 1e6 / tokens : 0, worstTick };
}

/** USDC (after the fee) that selling `tokens` into the bids returns, down to `limitTick`. */
export function quoteSell(book: BookSide, tokens: bigint, feeBps: bigint, limitTick = 1): Quote {
  let left = tokens - (tokens % LOT);
  let usdc = 0n;
  let worstTick: number | null = null;
  for (const level of book.bids) {
    if (level.tick < limitTick || left === 0n) break;
    const take = left < level.size ? left : level.size - (level.size % LOT);
    if (take <= 0n) continue;
    usdc += cost(take, level.tick);
    left -= take;
    worstTick = level.tick;
  }
  const sold = tokens - (tokens % LOT) - left;
  const out = usdc - feeOn(usdc, feeBps);
  const t = Number(sold) / 1e6;
  return { out, filled: sold, complete: left === 0n && sold > 0n, averagePrice: t > 0 ? Number(out) / 1e6 / t : 0, worstTick };
}

/** The least `out` a trade accepts, `slippageBps` below the quote. */
export const minimumOut = (out: bigint, slippageBps: number) => (out * (BPS - BigInt(slippageBps))) / BPS;

/** An anchored swap fills only within 0.10 USDC of the attention-implied value (the book's MAX_DEVIATION). */
export const ANCHOR_BAND = 0.1;

/** The worst tick an anchored swap may reach, from the implied value of the token (0 to 1 USDC). */
export function anchoredLimit(buy: boolean, fair: number): number {
  const f = Math.round(fair * 1e6);
  return buy ? Math.min(999, Math.floor((f + 100_000) / 1000)) : Math.max(1, Math.ceil(Math.max(0, f - 100_000) / 1000));
}

/** Best bid and ask in USDC per token. */
export function topOfBook(book: BookSide | null | undefined): { bid: number | null; ask: number | null } {
  return { bid: book?.bids[0] ? book.bids[0].tick / 1000 : null, ask: book?.asks[0] ? book.asks[0].tick / 1000 : null };
}

/** The mid of a book, or the side there is. */
export function mid(book: BookSide | null | undefined): number | null {
  const { bid, ask } = topOfBook(book);
  return bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
}

// --- Attention perps (contracts/perps) -------------------------------------------------------

export const PERP = {
  maxLeverage: 3,
  feeBps: 10n,
  maintenanceBps: 1_000n,
  /** Funding per second at full skew, as a WAD fraction of notional (about 4.3% a day); also the cap. */
  fundingPerSecAtFullSkew: 500_000_000_000n,
  minMargin: USDC,
} as const;

/** The index never leaves 0 to 100 points. */
export const INDEX_MAX = 100;

/** Signed funding rate per second (WAD fraction of notional), positive when longs pay. */
export function fundingRate(longQty: bigint, shortQty: bigint): bigint {
  const total = longQty + shortQty;
  if (total === 0n || longQty === shortQty) return 0n;
  const diff = longQty > shortQty ? longQty - shortQty : shortQty - longQty;
  let r = (diff * PERP.fundingPerSecAtFullSkew) / total;
  if (r > PERP.fundingPerSecAtFullSkew) r = PERP.fundingPerSecAtFullSkew;
  return longQty > shortQty ? r : -r;
}

/** What one side pays (positive) or earns (negative) per hour, percent of its notional. */
export function fundingPerHourPct(longQty: bigint, shortQty: bigint, isLong: boolean): number {
  const rate = fundingRate(longQty, shortQty);
  if (rate === 0n) return 0;
  const perHour = (Number(rate < 0n ? -rate : rate) / 1e18) * 3600 * 100;
  const longsPay = rate > 0n;
  if (longsPay === isLong) return perHour;
  const [payQty, recvQty] = longsPay ? [longQty, shortQty] : [shortQty, longQty];
  return recvQty === 0n ? 0 : -perHour * (Number(payQty) / Number(recvQty));
}

export interface PerpPreview {
  /** Margin after the opening fee (raw USDC). */
  net: bigint;
  fee: bigint;
  notional: bigint;
  /** WAD contracts. */
  qty: bigint;
  /** USDC gained or lost per index point. */
  perPoint: number;
  /** Index (points) at which the position can be liquidated, or null outside 0 to 100. */
  liquidationIndex: number | null;
  fundingPerHourPct: number;
  /** This side's notional after the trade (raw USDC), against the open interest cap. */
  sideNotionalAfter: bigint;
  /** Fee to close at today's index (raw USDC). */
  closeFee: bigint;
}

/** The perps contract's open arithmetic (`on_open_checked`), before it is sent. */
export function perpPreview(p: { margin: bigint; leverage: number; index: number; isLong: boolean; longQty: bigint; shortQty: bigint }): PerpPreview | null {
  if (p.margin <= 0n || p.index <= 0 || p.leverage <= 0 || p.leverage > PERP.maxLeverage) return null;
  const levBps = BigInt(Math.round(p.leverage * 10_000));
  const idx = BigInt(indexRaw(p.index));
  // margin = net + fee and fee = net x leverage x fee rate.
  const net = (p.margin * BPS * BPS) / (BPS * BPS + levBps * PERP.feeBps);
  const fee = p.margin - net;
  const notional = (net * levBps) / BPS;
  const qty = (notional * WAD) / idx;
  if (qty === 0n) return null;
  const perPoint = Number(qty) / 1e18;
  const n = Number(net) / 1e6;
  const m = Number(PERP.maintenanceBps) / Number(BPS);
  const liq = p.isLong ? (perPoint * p.index - n) / ((1 - m) * perPoint) : (n + perPoint * p.index) / ((1 + m) * perPoint);
  const longAfter = p.longQty + (p.isLong ? qty : 0n);
  const shortAfter = p.shortQty + (p.isLong ? 0n : qty);
  const sideQty = p.isLong ? longAfter : shortAfter;
  return {
    net,
    fee,
    notional,
    qty,
    perPoint,
    liquidationIndex: liq <= 0 || liq >= INDEX_MAX ? null : liq,
    fundingPerHourPct: fundingPerHourPct(longAfter, shortAfter, p.isLong),
    sideNotionalAfter: (sideQty * idx) / WAD,
    closeFee: (notional * PERP.feeBps) / BPS,
  };
}

/** The worst index a perp order accepts (raw): above the current one for longs, below for shorts. */
export function acceptableIndex(index: number, isLong: boolean, slippageBps: number): number {
  const raw = indexRaw(index);
  return Math.round(isLong ? (raw * (10_000 + slippageBps)) / 10_000 : (raw * (10_000 - slippageBps)) / 10_000);
}

/** A position's live numbers from `position_state` (raw strings), with its liquidation index in points. */
export function perpNumbers(p: { qty: bigint; margin: bigint; equity: bigint; notional: bigint; liquidationIndex: number }) {
  const margin = Number(p.margin) / 1e6;
  const equity = Number(p.equity) / 1e6;
  const notional = Number(p.notional) / 1e6;
  const pnl = equity - margin;
  const liq = p.liquidationIndex / INDEX_SCALE;
  return {
    perPoint: Number(p.qty) / 1e18,
    notional,
    leverage: margin > 0 ? notional / margin : 0,
    pnl,
    pnlPct: margin > 0 ? (pnl / margin) * 100 : 0,
    liquidationIndex: liq > 0 && liq < INDEX_MAX ? liq : null,
  };
}

export { formatAmount, parseAmount } from "@/lib/amount";
