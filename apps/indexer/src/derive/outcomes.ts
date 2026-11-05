import type { Tx } from "../db";
import { nep245, outcomes as ev, parseTokenId } from "../events";
import { type Ctx, type Handler, num, on, secs } from "./context";

type Side = "up" | "down";

/** One leg of `outcome_flows`, signed from the account's side. */
export async function flow(
  c: Ctx,
  leg: number,
  f: { account: string; series: number; side: Side | "set"; kind: string; tokens: bigint; usdc: bigint; fee?: bigint },
) {
  await c.tx`
    insert into outcome_flows (receipt_id, log_index, leg, account, series, side, kind, tokens, usdc, fee, at, block_height)
    values (${c.e.receipt_id}, ${c.e.log_index}, ${leg}, ${f.account}, ${f.series}, ${f.side}, ${f.kind}, ${num(f.tokens)},
            ${num(f.usdc)}, ${num(f.fee ?? 0n)}, ${c.e.block_time}, ${c.e.block_height})
    on conflict do nothing`;
}

async function addBalance(tx: Tx, account: string, series: number, side: Side, delta: bigint, at: Date) {
  const [row] = await tx<{ balance: string }[]>`
    insert into outcome_balances (account, series, side, balance, updated_at)
    values (${account}, ${series}, ${side}, ${num(delta)}, ${at})
    on conflict (account, series, side) do update
      set balance = outcome_balances.balance + excluded.balance, updated_at = excluded.updated_at
    returning balance::text`;
  if (row && BigInt(row.balance) === 0n) {
    await tx`delete from outcome_balances where account = ${account} and series = ${series} and side = ${side}`;
  }
}

async function addSupply(tx: Tx, series: number, side: Side, delta: bigint) {
  if (side === "up") await tx`update series set up_supply = up_supply + ${num(delta)} where id = ${series}`;
  else await tx`update series set down_supply = down_supply + ${num(delta)} where id = ${series}`;
}

async function addBacking(tx: Tx, series: number, delta: bigint) {
  await tx`update series set backing = backing + ${num(delta)} where id = ${series}`;
}

/** (token, amount) pairs of one NEP-245 entry, skipping ids that are not outcome tokens. */
function* tokens(item: { token_ids: string[]; amounts: string[] }) {
  for (let i = 0; i < item.token_ids.length && i < item.amounts.length; i++) {
    const t = parseTokenId(item.token_ids[i]!);
    if (t) yield { ...t, amount: BigInt(item.amounts[i]!) };
  }
}

/**
 * How a payout of settled tokens splits between the UP and DOWN legs: all to the winning side,
 * half a token each when void. Without the series' outcome (not indexed), in proportion to the
 * tokens.
 */
async function payoutShares(tx: Tx, series: number, up: bigint, down: bigint, payout: bigint): Promise<[bigint, bigint]> {
  const [s] = await tx<{ outcome: string }[]>`select outcome from series where id = ${series}`;
  switch (s?.outcome) {
    case "up":
      return [payout, 0n];
    case "down":
      return [0n, payout];
    case "void":
      return [up / 2n, down / 2n];
    default: {
      const upShare = up + down > 0n ? (payout * up) / (up + down) : 0n;
      return [upShare, payout - upShare];
    }
  }
}

export const outcomesHandlers: Record<string, Handler> = {
  series_opened: on(ev.series_opened, async ({ tx }, d) => {
    await tx`
      insert into series (id, trend, window_sec, number, opened_at, expiry, opening_index)
      values (${d.series}, ${d.trend}, ${d.window}, ${d.number}, ${secs(d.opened_at)}, ${secs(d.expiry)}, ${d.opening_index})
      on conflict (id) do nothing`;
  }),

  series_settled: on(ev.series_settled, async ({ tx, e }, d) => {
    await tx`
      update series set outcome = ${d.outcome}, settlement_index = ${d.settlement_index ?? null}, settled_at = ${e.block_time}
      where id = ${d.series}`;
  }),

  sets_minted: on(ev.sets_minted, async (c, d) => {
    const amount = BigInt(d.amount);
    await addBacking(c.tx, d.series, amount);
    await flow(c, 0, { account: d.receiver, series: d.series, side: "set", kind: "mint", tokens: amount, usdc: -amount });
  }),

  sets_redeemed: on(ev.sets_redeemed, async (c, d) => {
    const amount = BigInt(d.amount);
    await addBacking(c.tx, d.series, -amount);
    await flow(c, 0, { account: d.owner, series: d.series, side: "set", kind: "redeem", tokens: -amount, usdc: amount });
  }),

  winnings_redeemed: on(ev.winnings_redeemed, async (c, d) => {
    const [up, down, payout] = [BigInt(d.up), BigInt(d.down), BigInt(d.payout)];
    await addBacking(c.tx, d.series, -payout);
    const [upUsdc, downUsdc] = await payoutShares(c.tx, d.series, up, down, payout);
    const base = { account: d.owner, series: d.series, kind: "winnings" };
    if (up > 0n) await flow(c, 0, { ...base, side: "up", tokens: -up, usdc: upUsdc });
    if (down > 0n) await flow(c, 1, { ...base, side: "down", tokens: -down, usdc: downUsdc });
  }),

  /** The payout transfer failed: the contract minted the tokens back and kept the USDC. */
  payout_failed: on(ev.payout_failed, async (c, d) => {
    const amount = BigInt(d.amount);
    await addBacking(c.tx, d.series, amount);
    let up = 0n;
    let down = 0n;
    for (const m of c.receipt) {
      if (m.standard !== "nep245" || m.event !== "mt_mint") continue;
      const items = nep245.mt_mint.safeParse(m.data);
      if (!items.success) continue;
      for (const item of items.data) {
        if (item.owner_id !== d.owner) continue;
        for (const t of tokens(item)) {
          if (t.series !== d.series) continue;
          if (t.side === "up") up += t.amount;
          else down += t.amount;
        }
      }
    }
    const base = { account: d.owner, series: d.series, kind: "payout_failed" };
    if (up === amount && down === amount) {
      await flow(c, 0, { ...base, side: "set", tokens: amount, usdc: -amount });
      return;
    }
    const [upUsdc, downUsdc] = await payoutShares(c.tx, d.series, up, down, amount);
    if (up > 0n) await flow(c, 0, { ...base, side: "up", tokens: up, usdc: -upUsdc });
    if (down > 0n) await flow(c, 1, { ...base, side: "down", tokens: down, usdc: -downUsdc });
  }),
};

export const multiTokenHandlers: Record<string, Handler> = {
  mt_mint: on(nep245.mt_mint, async ({ tx, e }, items) => {
    for (const item of items) {
      for (const t of tokens(item)) {
        await addBalance(tx, item.owner_id, t.series, t.side, t.amount, e.block_time);
        await addSupply(tx, t.series, t.side, t.amount);
      }
    }
  }),

  mt_burn: on(nep245.mt_burn, async ({ tx, e }, items) => {
    for (const item of items) {
      for (const t of tokens(item)) {
        await addBalance(tx, item.owner_id, t.series, t.side, -t.amount, e.block_time);
        await addSupply(tx, t.series, t.side, -t.amount);
      }
    }
  }),

  mt_transfer: on(nep245.mt_transfer, async ({ tx, e }, items) => {
    for (const item of items) {
      for (const t of tokens(item)) {
        await addBalance(tx, item.old_owner_id, t.series, t.side, -t.amount, e.block_time);
        await addBalance(tx, item.new_owner_id, t.series, t.side, t.amount, e.block_time);
      }
    }
  }),
};
