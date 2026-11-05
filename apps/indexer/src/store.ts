import { DERIVED_TABLES, type Sql, type Tx } from "./db";
import type { Tracker } from "./deployments";
import { applyEvents } from "./derive";
import type { StoredEvent } from "./extract";
import type { Log } from "./log";

export interface Cursor {
  height: number;
  blockTime: Date | null;
}

export async function readCursor(sql: Sql | Tx, network: string): Promise<Cursor | null> {
  const [row] = await sql<{ height: string; block_time: Date | null }[]>`select height, block_time from cursor where id = ${network}`;
  return row ? { height: Number(row.height), blockTime: row.block_time } : null;
}

/** Networks other than `network` that already wrote to this schema. */
export async function otherNetworks(sql: Sql, network: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from cursor where id <> ${network}`;
  return rows.map((r) => r.id);
}

export async function writeCursor(sql: Sql | Tx, network: string, c: Cursor): Promise<void> {
  await sql`
    insert into cursor (id, height, block_time, updated_at) values (${network}, ${c.height}, ${c.blockTime}, now())
    on conflict (id) do update set height = excluded.height, block_time = coalesce(excluded.block_time, cursor.block_time), updated_at = now()`;
}

/** Rows per insert statement (11 parameters each, well under Postgres' 65535). */
const INSERT_BATCH = 1000;

const EVENT_COLUMNS = [
  "block_height",
  "block_time",
  "idx",
  "receipt_id",
  "tx_hash",
  "executor",
  "standard",
  "version",
  "event",
  "data",
  "log_index",
] as const;

/**
 * Stores a block's events and applies the new ones to the derived tables, and moves the cursor
 * to the block, all in one transaction. Re-processing a block stores and applies nothing twice.
 * Returns the number of events stored for the first time.
 */
export async function commitBlock(
  sql: Sql,
  network: string,
  cursor: Cursor,
  events: StoredEvent[],
  tracker: Tracker,
  log: Log,
  isolate = false,
): Promise<number> {
  return sql.begin(async (tx) => {
    const keys = new Set<string>();
    for (let i = 0; i < events.length; i += INSERT_BATCH) {
      const rows = events.slice(i, i + INSERT_BATCH).map((e) => ({ ...e, data: tx.json(e.data as never) }));
      const inserted = await tx<{ receipt_id: string; log_index: number }[]>`
        insert into events ${tx(rows, ...EVENT_COLUMNS)}
        on conflict (receipt_id, log_index) do nothing
        returning receipt_id, log_index`;
      for (const r of inserted) keys.add(`${r.receipt_id}#${r.log_index}`);
    }
    const fresh = events.filter((e) => keys.has(`${e.receipt_id}#${e.log_index}`));
    if (fresh.length) await applyEvents(tx, fresh, tracker, log, isolate);
    await writeCursor(tx, network, cursor);
    return fresh.length;
  });
}

/** Empties every derived table. */
export async function truncateDerived(sql: Sql | Tx): Promise<void> {
  await sql.unsafe(`truncate ${DERIVED_TABLES.join(", ")}`);
}

interface EventRow extends Omit<StoredEvent, "block_height"> {
  block_height: string;
}

/**
 * Rebuilds every derived table from `events` alone: truncates them, then replays the events in
 * block order, a batch of whole blocks per transaction (a receipt never spans two batches).
 */
export async function rebuild(sql: Sql, tracker: Tracker, log: Log, blocksPerBatch = 500): Promise<{ events: number; skipped: number }> {
  await truncateDerived(sql);
  let after = -1;
  let total = 0;
  let skipped = 0;
  for (;;) {
    const heights = await sql<{ h: string }[]>`
      select distinct block_height as h from events where block_height > ${after} order by 1 limit ${blocksPerBatch}`;
    if (!heights.length) break;
    const last = Number(heights[heights.length - 1]!.h);
    const rows = await sql<EventRow[]>`
      select block_height, block_time, idx, receipt_id, tx_hash, executor, standard, version, event, data, log_index
      from events where block_height > ${after} and block_height <= ${last}
      order by block_height, idx`;
    const events: StoredEvent[] = rows.map((r) => ({ ...r, block_height: Number(r.block_height) }));
    const stats = await sql.begin((tx) => applyEvents(tx, events, tracker, log, true));
    total += events.length;
    skipped += stats.skipped;
    after = last;
    log.info("rebuild progress", { height: last, events: total });
  }
  return { events: total, skipped };
}
