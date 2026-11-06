import type { Curve, CurveQuote, Depth, IndexSnapshot, Mark, Order, PerpMarket, Position, PositionState, Series, Side } from "@tredio/contracts";
import { view, ViewError } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import type { BookSide } from "./math";

/** Reads of the Tredio contracts, shaped for the screens. */

const c = DEPLOYMENT.contracts;
export const INDEX_SCALE = 1_000_000;
const points = (raw: number) => raw / INDEX_SCALE;

/** The registry's own view of a trend: the index the contracts trade at, and whether it is fresh. */
export interface IndexView {
  index: number;
  peakIndex: number;
  updatedAt: number;
  fresh: boolean;
  status: IndexSnapshot["status"];
}

export async function readIndex(trend: string): Promise<IndexView | null> {
  const s = await view<IndexSnapshot | null>(c.registry, "index_of", { id: trend });
  return s ? { index: points(s.index), peakIndex: points(s.peak_index), updatedAt: s.updated_at, fresh: s.fresh, status: s.status } : null;
}

export interface SeriesView {
  series: number;
  trend: string;
  window: number;
  openedAt: number;
  expiry: number;
  /** Points. */
  openingIndex: number;
  settlementIndex: number | null;
  outcome: Series["outcome"];
  /** True once the book lists both of its tokens. */
  listed: boolean;
}

let windows: Promise<number[]> | null = null;
/** The series windows the outcomes contract opens (24 hours, 7 days, and a short test window on testnet). */
export function seriesWindows(): Promise<number[]> {
  windows ??= view<number[]>(c.outcomes, "windows").catch((e: unknown) => {
    windows = null;
    throw e;
  });
  return windows;
}

const seriesView = (s: Series, listed: boolean): SeriesView => ({
  series: s.id,
  trend: s.trend,
  window: s.window,
  openedAt: s.opened_at,
  expiry: s.expiry,
  openingIndex: points(s.opening_index),
  settlementIndex: s.settlement_index === null ? null : points(s.settlement_index),
  outcome: s.outcome,
  listed,
});

/** The newest series of each window for a trend, with whether the book lists it. */
export async function readSeries(trend: string): Promise<SeriesView[]> {
  const ws = await seriesWindows();
  const latest = await Promise.all(ws.map((w) => view<Series | null>(c.outcomes, "latest_series", { trend, window: w })));
  const found = latest.filter((s): s is Series => s !== null);
  const listed = await Promise.all(found.map((s) => view<unknown>(c.book, "get_market", { series: s.id, side: "up" }).then((m) => m !== null)));
  return found.map((s, i) => seriesView(s, listed[i]!));
}

export async function readSeriesById(series: number): Promise<SeriesView | null> {
  const [s, m] = await Promise.all([view<Series | null>(c.outcomes, "get_series", { series }), view<unknown>(c.book, "get_market", { series, side: "up" }).catch(() => null)]);
  return s ? seriesView(s, m !== null) : null;
}

/** A book market's best levels, or null when the book does not list it. */
export async function readDepth(series: number, side: Side, levels = 10): Promise<BookSide | null> {
  try {
    const d = await view<Depth>(c.book, "depth", { series, side, levels });
    const conv = (l: Depth["bids"]) => l.map((x) => ({ tick: x.tick, size: BigInt(x.size) }));
    return { bids: conv(d.bids), asks: conv(d.asks) };
  } catch (e) {
    if (e instanceof ViewError && /unknown market/.test(e.message)) return null;
    throw e;
  }
}

/** The attention-implied value of one UP token (USDC, 0 to 1) the registry computes. */
export async function readFairUp(trend: string, openingIndexPoints: number, expiry: number): Promise<number | null> {
  try {
    return Number(await view<string>(c.registry, "fair_up", { id: trend, opening: Math.round(openingIndexPoints * INDEX_SCALE), expiry })) / 1e6;
  } catch {
    return null;
  }
}

export const tokenId = (series: number, side: Side) => `${series}:${side}`;

/** UP and DOWN balances (raw) of a series. */
export async function readOutcomeBalances(account: string, series: number): Promise<{ up: bigint; down: bigint }> {
  const [up, down] = await view<string[]>(c.outcomes, "mt_batch_balance_of", { account_id: account, token_ids: [tokenId(series, "up"), tokenId(series, "down")] });
  return { up: BigInt(up ?? "0"), down: BigInt(down ?? "0") };
}

/** What the account holds inside the book (from limit orders and their fills), raw. */
export async function readBookBalances(account: string, series: number): Promise<{ usdc: bigint; up: bigint; down: bigint }> {
  const [usdc, up, down] = await Promise.all([
    view<string>(c.book, "balance_of", { account_id: account, asset: "usdc" }),
    view<string>(c.book, "balance_of", { account_id: account, asset: { token: { series, side: "up" } } }),
    view<string>(c.book, "balance_of", { account_id: account, asset: { token: { series, side: "down" } } }),
  ]);
  return { usdc: BigInt(usdc), up: BigInt(up), down: BigInt(down) };
}

export async function readBookUsdc(account: string): Promise<bigint> {
  return BigInt(await view<string>(c.book, "balance_of", { account_id: account, asset: "usdc" }));
}

export async function readOrder(id: number): Promise<Order | null> {
  return view<Order | null>(c.book, "get_order", { order_id: id });
}

/** Whether `account` is registered for storage with `contract`. */
export async function isRegistered(contract: string, account: string): Promise<boolean> {
  return (await view<unknown>(contract, "storage_balance_of", { account_id: account }).catch(() => null)) !== null;
}

// --- Perps ------------------------------------------------------------------------------------

export interface PerpMarketView {
  longQty: bigint;
  shortQty: bigint;
  /** Each side's notional cap at the index (raw USDC). */
  cap: bigint;
}

export async function readPerpMarket(trend: string, indexPoints: number): Promise<PerpMarketView> {
  const [m, cap] = await Promise.all([view<PerpMarket>(c.perps, "get_market", { trend }), view<string>(c.perps, "open_interest_cap", { index: Math.round(indexPoints * INDEX_SCALE) })]);
  return { longQty: BigInt(m.long_qty), shortQty: BigInt(m.short_qty), cap: BigInt(cap) };
}

export interface PerpPositionView {
  id: number;
  trend: string;
  isLong: boolean;
  entryIndex: number;
  qty: bigint;
  margin: bigint;
  openedAt: number;
  /** Live, at the market's last mark, funding included. */
  index: number;
  equity: bigint;
  pnl: bigint;
  funding: bigint;
  notional: bigint;
  liquidatable: boolean;
  /** Raw index. */
  liquidationIndex: number;
}

export async function readPerpPositions(account: string): Promise<PerpPositionView[]> {
  const list = await view<Position[]>(c.perps, "positions_of", { account_id: account });
  const states = await Promise.all(list.map((p) => view<PositionState>(c.perps, "position_state", { id: p.id }).catch(() => null)));
  return list.map((p, i) => {
    const s = states[i];
    return {
      id: p.id,
      trend: p.trend,
      isLong: p.is_long,
      entryIndex: points(p.entry_index),
      qty: BigInt(p.qty),
      margin: BigInt(p.margin),
      openedAt: p.opened_at,
      index: s ? points(s.index) : points(p.entry_index),
      equity: s ? BigInt(s.equity) : BigInt(p.margin),
      pnl: s ? BigInt(s.pnl) : 0n,
      funding: s ? BigInt(s.funding) : 0n,
      notional: s ? BigInt(s.notional) : 0n,
      liquidatable: s?.liquidatable ?? false,
      liquidationIndex: s?.liquidation_index ?? 0,
    };
  });
}

// --- Coins ------------------------------------------------------------------------------------

export interface CurveView extends Curve {
  /** USDC per whole coin. */
  spot: number;
  graduationReserve: bigint;
}

let graduation: Promise<bigint> | null = null;

export async function readCurve(trend: string): Promise<CurveView | null> {
  graduation ??= view<string>(c.coins, "graduation_reserve")
    .then(BigInt)
    .catch((e: unknown) => {
      graduation = null;
      throw e;
    });
  const curve = await view<Curve | null>(c.coins, "get_curve", { trend });
  if (!curve) return null;
  const [spot, reserve] = await Promise.all([curve.stage === "creating" ? Promise.resolve("0") : view<string>(c.coins, "spot_price", { trend }), graduation]);
  return { ...curve, spot: Number(spot) / 1e18 / 1e6, graduationReserve: reserve };
}

export async function readCurveQuote(trend: string, side: "buy" | "sell", amount: bigint): Promise<{ out: bigint; fee: bigint; spotAfter: number } | null> {
  const q = await view<CurveQuote | null>(c.coins, side === "buy" ? "quote_buy" : "quote_sell", side === "buy" ? { trend, usdc_in: amount.toString() } : { trend, coins_in: amount.toString() });
  return q ? { out: BigInt(q.out), fee: BigInt(q.fee), spotAfter: Number(q.spot_after) / 1e18 / 1e6 } : null;
}

export async function readTokenBalance(token: string, account: string): Promise<bigint> {
  return BigInt((await view<string | null>(token, "ft_balance_of", { account_id: account }).catch(() => "0")) ?? "0");
}

export async function readCurves(): Promise<Curve[]> {
  const out: Curve[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Curve[]>(c.coins, "get_curves", { from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

// --- Curation and marks -------------------------------------------------------------------------

export async function readCuration(account: string): Promise<{ claimable: bigint; earned: bigint }> {
  const [claimable, earned] = await Promise.all([view<string>(c.curation, "claimable_of", { account_id: account }), view<string>(c.curation, "earned_by_account", { account_id: account })]);
  return { claimable: BigInt(claimable), earned: BigInt(earned) };
}

/** The registry's Hyperliquid mark for an asset (price with 8 decimals), which the account's guard checks orders against. */
export async function readMark(asset: string): Promise<{ price: number; at: number } | null> {
  const m = await view<Mark | null>(c.registry, "mark_of", { asset });
  return m ? { price: Number(m.price) / 1e8, at: m.at } : null;
}
