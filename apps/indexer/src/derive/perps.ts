import { perps as ev } from "../events";
import { type Handler, on, secs } from "./context";

export const perpsHandlers: Record<string, Handler> = {
  poked: on(ev.poked, async ({ tx }, d) => {
    await tx`
      insert into perp_funding (trend, at, cum_long, cum_short, mark)
      values (${d.trend}, ${secs(d.at)}, ${d.cum_long}, ${d.cum_short}, ${d.mark})
      on conflict (trend, at) do update set cum_long = excluded.cum_long, cum_short = excluded.cum_short, mark = excluded.mark`;
  }),

  position_opened: on(ev.position_opened, async ({ tx, e }, d) => {
    await tx`
      insert into perp_positions (id, owner, payer, trend, is_long, qty, margin, entry_index, fee_open, opened_at)
      values (${d.id}, ${d.owner}, ${d.payer}, ${d.trend}, ${d.is_long}, ${d.qty}, ${d.margin}, ${d.entry_index}, ${d.fee}, ${e.block_time})
      on conflict (id) do nothing`;
  }),

  margin_added: on(ev.margin_added, async ({ tx }, d) => {
    await tx`update perp_positions set margin = margin + ${d.amount}::numeric where id = ${d.id}`;
  }),

  /** A close by the owner, or the settlement of a retired trend's position (`retired`). */
  position_closed: on(ev.position_closed, async ({ tx, e }, d) => {
    await tx`
      update perp_positions
      set status = ${d.retired ? "settled" : "closed"}, exit_index = ${d.exit_index}, qty = ${d.qty}, margin = ${d.margin},
          pnl = ${d.pnl}, funding = ${d.funding}, fee_close = ${d.fee}, payout = ${d.payout},
          closed_at = ${e.block_time}, close_receipt = ${e.receipt_id}
      where id = ${d.id}`;
  }),

  /** The margin goes to the pool; the owner is paid nothing. */
  position_liquidated: on(ev.position_liquidated, async ({ tx, e }, d) => {
    await tx`
      update perp_positions
      set status = 'liquidated', exit_index = ${d.exit_index}, equity = ${d.equity}, reward = ${d.reward},
          liquidator = ${d.liquidator}, payout = 0, closed_at = ${e.block_time}, close_receipt = ${e.receipt_id}
      where id = ${d.id}`;
  }),

  socialized_loss: on(ev.socialized_loss, async ({ tx }, d) => {
    await tx`update perp_positions set shortfall = ${d.shortfall} where id = ${d.id}`;
  }),
};
