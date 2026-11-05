import { nep141 } from "../events";
import { type Handler, on } from "./context";

/** NEP-141 events of the USDC contract. */
export const usdcHandlers: Record<string, Handler> = {
  ft_transfer: on(nep141.ft_transfer, async ({ tx, e }, items) => {
    const rows = items.map((i, n) => ({
      receipt_id: e.receipt_id,
      log_index: e.log_index,
      n,
      old_owner: i.old_owner_id,
      new_owner: i.new_owner_id,
      amount: i.amount,
      memo: i.memo ?? null,
      at: e.block_time,
      block_height: e.block_height,
    }));
    if (rows.length) await tx`insert into usdc_transfers ${tx(rows)} on conflict do nothing`;
  }),

  ft_mint: on(nep141.ft_mint, async ({ tx, e }, items) => {
    const rows = items.map((i, n) => ({
      receipt_id: e.receipt_id,
      log_index: e.log_index,
      n,
      owner: i.owner_id,
      amount: i.amount,
      memo: i.memo ?? null,
      at: e.block_time,
      block_height: e.block_height,
    }));
    if (rows.length) await tx`insert into usdc_mints ${tx(rows)} on conflict do nothing`;
  }),
};
