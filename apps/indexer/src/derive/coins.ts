import { coins as ev, nep141 } from "../events";
import type { Tx } from "../db";
import { type Handler, num, on } from "./context";

/** Virtual token side of every curve (1e9 coins, 18 decimals); spot = quote x 1e36 / tokens. */
const VIRTUAL_TOKENS = "1000000000000000000000000000";
const SPOT_SCALE = "1000000000000000000000000000000000000";

export const coinsHandlers: Record<string, Handler> = {
  curve_created: on(ev.curve_created, async ({ tx, e }, d) => {
    await tx`
      insert into curves (trend, coin, stage, virtual_quote, reserve, sold, spot, peak_at_creation, created_at)
      values (${d.trend}, ${d.coin}, 'open', ${d.virtual_quote}, 0, 0,
              div(${d.virtual_quote}::numeric * ${SPOT_SCALE}::numeric, ${VIRTUAL_TOKENS}::numeric),
              ${d.peak_at_creation}, ${e.block_time})
      on conflict (trend) do nothing`;
  }),

  /** A sale that takes a filled curve back under the graduation reserve reopens it. */
  trade: on(ev.trade, async ({ tx, e, tracker }, d) => {
    await tx`
      insert into coin_trades (receipt_id, log_index, trend, trader, is_buy, usdc, coins, fee, reserve, sold, spot, at, block_height)
      values (${e.receipt_id}, ${e.log_index}, ${d.trend}, ${d.trader}, ${d.is_buy}, ${d.usdc}, ${d.coins}, ${d.fee},
              ${d.reserve}, ${d.sold}, ${d.spot}, ${e.block_time}, ${e.block_height})
      on conflict do nothing`;
    await tx`
      update curves
      set reserve = ${d.reserve}, sold = ${d.sold}, spot = ${d.spot},
          stage = case when stage = 'ready' and ${!d.is_buy} and ${d.reserve}::numeric < ${num(tracker.graduationReserve)}::numeric
                       then 'open' else stage end
      where trend = ${d.trend}`;
  }),

  /** The floor rose: the cost moved from the floor reserve into the reserve. */
  floor_raised: on(ev.floor_raised, async ({ tx }, d) => {
    await tx`
      update curves
      set virtual_quote = ${d.virtual_quote}, reserve = reserve + ${d.cost}::numeric,
          spot = div((${d.virtual_quote}::numeric + reserve + ${d.cost}::numeric) * ${SPOT_SCALE}::numeric,
                     ${VIRTUAL_TOKENS}::numeric - sold)
      where trend = ${d.trend}`;
  }),

  graduation_ready: on(ev.graduation_ready, async ({ tx }, d) => {
    await tx`update curves set stage = 'ready', reserve = ${d.reserve} where trend = ${d.trend}`;
  }),

  /** The pool exists: the curve closes and its USDC is set aside for the pool. */
  graduation_step: on(ev.graduation_step, async ({ tx }, d) => {
    if (d.step !== "pool" || !d.ok) return;
    await tx`update curves set stage = 'pooled', reserve = 0 where trend = ${d.trend} and stage = 'ready'`;
  }),

  graduated: on(ev.graduated, async ({ tx, e }, d) => {
    await tx`update curves set stage = 'graduated', pool_id = ${d.pool_id}, graduated_at = ${e.block_time} where trend = ${d.trend}`;
  }),
};

async function addCoins(tx: Tx, coin: string, account: string, delta: bigint, at: Date) {
  const [row] = await tx<{ balance: string }[]>`
    insert into coin_balances (coin, account, balance, updated_at) values (${coin}, ${account}, ${num(delta)}, ${at})
    on conflict (coin, account) do update set balance = coin_balances.balance + excluded.balance, updated_at = excluded.updated_at
    returning balance::text`;
  if (row && BigInt(row.balance) === 0n) await tx`delete from coin_balances where coin = ${coin} and account = ${account}`;
}

/** NEP-141 events of a trend coin (the executor is the coin). */
export const coinTokenHandlers: Record<string, Handler> = {
  ft_mint: on(nep141.ft_mint, async ({ tx, e }, items) => {
    for (const i of items) await addCoins(tx, e.executor, i.owner_id, BigInt(i.amount), e.block_time);
  }),
  ft_burn: on(nep141.ft_burn, async ({ tx, e }, items) => {
    for (const i of items) await addCoins(tx, e.executor, i.owner_id, -BigInt(i.amount), e.block_time);
  }),
  ft_transfer: on(nep141.ft_transfer, async ({ tx, e }, items) => {
    for (const i of items) {
      await addCoins(tx, e.executor, i.old_owner_id, -BigInt(i.amount), e.block_time);
      await addCoins(tx, e.executor, i.new_owner_id, BigInt(i.amount), e.block_time);
    }
  }),
};
