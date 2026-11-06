import { registry as ev } from "../events";
import { type Handler, on, secs } from "./context";

export const registryHandlers: Record<string, Handler> = {
  trend_created: on(ev.trend_created, async ({ tx }, d) => {
    const at = secs(d.observed_at);
    await tx`
      insert into trends (id, asset_class, status, index, peak_index, surfacer, review_hash, asset, created_at, updated_at, status_since)
      values (${d.id}, ${d.asset_class}, 'active', ${d.index}, ${d.index}, ${d.surfacer ?? null}, ${d.review_hash ?? null},
              ${d.asset ?? null}, ${at}, ${at}, ${at})
      on conflict (id) do nothing`;
    await tx`
      insert into index_points (trend, at, index, clamped) values (${d.id}, ${at}, ${d.index}, false)
      on conflict (trend, at) do nothing`;
  }),

  index_updated: on(ev.index_updated, async ({ tx }, d) => {
    const at = secs(d.observed_at);
    await tx`update trends set index = ${d.index}, peak_index = ${d.peak_index}, updated_at = ${at} where id = ${d.id}`;
    await tx`
      insert into index_points (trend, at, index, clamped) values (${d.id}, ${at}, ${d.index}, ${d.clamped})
      on conflict (trend, at) do update set index = excluded.index, clamped = excluded.clamped`;
  }),

  status_changed: on(ev.status_changed, async ({ tx }, d) => {
    await tx`update trends set status = ${d.to}, status_since = ${secs(d.at)} where id = ${d.id}`;
  }),

  settlement_finalized: on(ev.settlement_finalized, async ({ tx, e }, d) => {
    await tx`
      insert into settlements (trend, expiry, value, missed, first_observation, at)
      values (${d.id}, ${secs(d.expiry)}, ${d.value}, false, null, ${e.block_time})
      on conflict (trend, expiry) do update set value = excluded.value, missed = false, first_observation = null, at = excluded.at`;
  }),

  settlement_missed: on(ev.settlement_missed, async ({ tx, e }, d) => {
    await tx`
      insert into settlements (trend, expiry, value, missed, first_observation, at)
      values (${d.id}, ${secs(d.expiry)}, null, true, ${secs(d.first_observation)}, ${e.block_time})
      on conflict (trend, expiry) do nothing`;
  }),

  mark_updated: on(ev.mark_updated, async ({ tx }, d) => {
    await tx`
      insert into marks (asset, price, at) values (${d.asset}, ${d.price}, ${secs(d.at)})
      on conflict (asset) do update set price = excluded.price, at = excluded.at where marks.at <= excluded.at`;
  }),

  /** Logged right after the same mark's `mark_updated`, so its row is there. */
  asset_index_set: on(ev.asset_index_set, async ({ tx }, d) => {
    await tx`update marks set asset_index = ${d.asset_index} where asset = ${d.asset}`;
  }),

  report_processed: on(ev.report_processed, async ({ tx, e }, d) => {
    await tx`
      insert into oracle_runs (run_id, observed_at, created, updated, marks, rejected, block_height, receipt_id)
      values (${d.run_id}, ${secs(d.observed_at)}, ${d.created}, ${d.updated}, ${d.marks}, ${d.rejected}, ${e.block_height}, ${e.receipt_id})
      on conflict (run_id) do nothing`;
  }),
};
