/**
 * Rebuilds the derived tables. Stop the indexer first (both take the schema lock).
 *
 *   bun run resync                   rebuild every derived table from indexer.events, no refetch
 *   bun run resync --refetch         also clear events and the cursor: the indexer refetches from the start block
 *   bun run resync --from <height>   clear events at and after <height>, rebuild from the rest, and
 *                                    move the cursor so the indexer refetches from <height>
 */
import { parseArgs } from "node:util";
import type { Sql } from "./db";
import { createLog, type Log } from "./log";
import { setup } from "./setup";
import { rebuild } from "./store";
import type { Tracker } from "./deployments";

export interface ResyncOptions {
  refetch: boolean;
  from?: number;
}

export async function resync(
  sql: Sql,
  network: string,
  startBlock: number,
  tracker: Tracker,
  log: Log,
  o: ResyncOptions,
): Promise<{ events: number; skipped: number }> {
  if (o.from !== undefined) {
    if (o.from < startBlock) throw new Error(`--from ${o.from} is before the start block ${startBlock}`);
    const deleted = await sql.begin(async (tx) => {
      const r = await tx`delete from events where block_height >= ${o.from!}`;
      await tx`
        insert into cursor (id, height, block_time, updated_at) values (${network}, ${o.from! - 1}, null, now())
        on conflict (id) do update set height = excluded.height, block_time = null, updated_at = now()`;
      return r.count;
    });
    log.info("events cleared from height", { from: o.from, deleted });
  } else if (o.refetch) {
    await sql.begin(async (tx) => {
      await tx`truncate events`;
      await tx`delete from cursor where id = ${network}`;
    });
    log.info("events and cursor cleared", { startBlock });
  }
  return rebuild(sql, tracker, log);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { refetch: { type: "boolean", default: false }, from: { type: "string" } },
    });
    const from = values.from === undefined ? undefined : Number(values.from);
    if (from !== undefined && (!Number.isInteger(from) || from <= 0)) throw new Error("--from takes a block height");
    const rt = await setup();
    try {
      const t0 = Date.now();
      const r = await resync(rt.sql, rt.cfg.NETWORK, rt.startBlock, rt.tracker, rt.log, { refetch: values.refetch!, from });
      rt.log.info("resync done", { ...r, ms: Date.now() - t0 });
    } finally {
      await rt.release();
      await rt.sql.end({ timeout: 5 });
    }
  } catch (e) {
    createLog().error("resync failed", { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}
