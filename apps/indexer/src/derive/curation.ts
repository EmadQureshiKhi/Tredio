import { curation as cur } from "../events";
import { type Handler, on } from "./context";

export const curationHandlers: Record<string, Handler> = {
  accrued: on(cur.accrued, async ({ tx, e }, d) => {
    await tx`
      insert into curation (receipt_id, log_index, trend, surfacer, source, amount, at, block_height)
      values (${e.receipt_id}, ${e.log_index}, ${d.trend}, ${d.surfacer}, ${d.source}, ${d.amount}, ${e.block_time}, ${e.block_height})
      on conflict do nothing`;
  }),

  claimed: on(cur.claimed, async ({ tx, e }, d) => {
    await tx`
      insert into curation_claims (receipt_id, log_index, account, amount, at, block_height)
      values (${e.receipt_id}, ${e.log_index}, ${d.account}, ${d.amount}, ${e.block_time}, ${e.block_height})
      on conflict do nothing`;
  }),
};
