import type { z } from "zod";
import { book as ev } from "../events";
import { type Ctx, type Handler, on, secs } from "./context";
import { flow } from "./outcomes";

type Trade = z.infer<typeof ev.trade>;

/** Trades of the receipt that a swap of `account` on (series, side) took, valid ones only. */
function swapTrades(c: Ctx, account: string, series: number, side: string): Trade[] {
  const out: Trade[] = [];
  for (const t of c.receipt) {
    if (t.standard !== "tredio-book" || t.event !== "trade") continue;
    const r = ev.trade.safeParse(t.data);
    if (r.success && r.data.taker === account && r.data.series === series && r.data.side === side) out.push(r.data);
  }
  return out;
}

/** True when the receipt also logs a swap for this taker: the swap row carries the taker's flow. */
function isSwapFill(c: Ctx, d: Trade): boolean {
  return c.receipt.some((s) => {
    if (s.standard !== "tredio-book" || s.event !== "swap") return false;
    const r = ev.swap.safeParse(s.data);
    return r.success && r.data.account === d.taker && r.data.series === d.series && r.data.side === d.side;
  });
}

export const bookHandlers: Record<string, Handler> = {
  market_listed: on(ev.market_listed, async ({ tx, e }, d) => {
    await tx`
      insert into book_markets (series, side, trend, expiry, listed_at)
      values (${d.series}, ${d.side}, ${d.trend}, ${secs(d.expiry)}, ${e.block_time})
      on conflict (series, side) do nothing`;
  }),

  order_placed: on(ev.order_placed, async ({ tx, e }, d) => {
    await tx`
      insert into book_orders (id, owner, series, side, dir, tick, size, remaining, status, placed_at, updated_at)
      values (${d.id}, ${d.owner}, ${d.series}, ${d.side}, ${d.dir}, ${d.tick}, ${d.size}, ${d.size}, 'open', ${e.block_time}, ${e.block_time})
      on conflict (id) do nothing`;
  }),

  order_cancelled: on(ev.order_cancelled, async ({ tx, e }, d) => {
    await tx`
      update book_orders set status = 'cancelled', remaining = ${d.remaining}, updated_at = ${e.block_time}
      where id = ${d.id}`;
  }),

  trade: on(ev.trade, async (c, d) => {
    const { tx, e } = c;
    await tx`
      insert into book_trades (receipt_id, log_index, series, side, maker_order, maker, taker, taker_dir, tick, size, usdc, fee, at, block_height)
      values (${e.receipt_id}, ${e.log_index}, ${d.series}, ${d.side}, ${d.maker_order}, ${d.maker}, ${d.taker}, ${d.taker_dir},
              ${d.tick}, ${d.size}, ${d.usdc}, ${d.fee}, ${e.block_time}, ${e.block_height})
      on conflict do nothing`;
    await tx`
      update book_orders
      set remaining = remaining - ${d.size}::numeric,
          status = case when remaining - ${d.size}::numeric <= 0 then 'filled' else status end,
          updated_at = ${e.block_time}
      where id = ${d.maker_order}`;
    await tx`
      update book_markets set last_tick = ${d.tick}, volume_usdc = volume_usdc + ${d.usdc}::numeric, trades = trades + 1
      where series = ${d.series} and side = ${d.side}`;
    const [size, usdc, fee] = [BigInt(d.size), BigInt(d.usdc), BigInt(d.fee)];
    const takerBuys = d.taker_dir === "buy";
    // The maker's resting order filled at its own price, without a fee.
    await flow(c, 0, {
      account: d.maker,
      series: d.series,
      side: d.side,
      kind: "fill",
      tokens: takerBuys ? -size : size,
      usdc: takerBuys ? usdc : -usdc,
    });
    if (isSwapFill(c, d)) return;
    await flow(c, 1, {
      account: d.taker,
      series: d.series,
      side: d.side,
      kind: "fill",
      tokens: takerBuys ? size : -size,
      usdc: takerBuys ? -(usdc + fee) : usdc - fee,
      fee,
    });
  }),

  swap: on(ev.swap, async (c, d) => {
    const { tx, e } = c;
    await tx`
      insert into book_swaps (receipt_id, log_index, account, series, side, dir, anchored, fair, amount_in, amount_out, at, block_height)
      values (${e.receipt_id}, ${e.log_index}, ${d.account}, ${d.series}, ${d.side}, ${d.dir}, ${d.anchored}, ${d.fair ?? null},
              ${d.amount_in}, ${d.amount_out}, ${e.block_time}, ${e.block_height})
      on conflict do nothing`;
    const fee = swapTrades(c, d.account, d.series, d.side).reduce((s, t) => s + BigInt(t.fee), 0n);
    const [amountIn, amountOut] = [BigInt(d.amount_in), BigInt(d.amount_out)];
    const buy = d.dir === "buy";
    await flow(c, 0, {
      account: d.account,
      series: d.series,
      side: d.side,
      kind: "swap",
      tokens: buy ? amountOut : -amountIn,
      usdc: buy ? -amountIn : amountOut,
      fee,
    });
  }),
};
