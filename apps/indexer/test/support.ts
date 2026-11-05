import { connect, DERIVED_TABLES, migrate, type Sql } from "../src/db";
import { Tracker } from "../src/deployments";
import { extractEvents } from "../src/extract";
import { silentLog } from "../src/log";
import type { Block } from "../src/neardata";
import { commitBlock } from "../src/store";
import { DEPLOYMENT } from "./fixtures/scenario";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  console.warn("Database tests skipped: set TEST_DATABASE_URL to a Postgres database the tests may write (each run uses its own schema).");
}

export const tracker = new Tracker(DEPLOYMENT);

/** A fresh, migrated schema of its own; `drop` removes it. */
export async function freshSchema(): Promise<{ sql: Sql; schema: string; drop: () => Promise<void> }> {
  const schema = `indexer_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const sql = connect(TEST_DATABASE_URL!, schema);
  await migrate(sql, schema);
  return {
    sql,
    schema,
    drop: async () => {
      await sql.unsafe(`drop schema if exists "${schema}" cascade`);
      await sql.end({ timeout: 5 });
    },
  };
}

/** Commits blocks the way the ingest loop does; returns the events stored for the first time. */
export async function commitAll(sql: Sql, blocks: Map<number, Block | null>, heights: number[]): Promise<number> {
  let n = 0;
  let time: Date | null = null;
  for (const h of heights) {
    const b = blocks.get(h) ?? null;
    if (b) time = new Date(Number(BigInt(b.block.header.timestamp_nanosec!) / 1_000_000n));
    const events = b ? extractEvents(b, tracker) : [];
    n += await commitBlock(sql, "testnet", { height: h, blockTime: time }, events, tracker, silentLog);
  }
  return n;
}

/** Every derived table's rows in a stable order. */
export async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of DERIVED_TABLES) out[t] = [...(await sql.unsafe(`select * from ${t} x order by x::text`))];
  return out;
}

export async function count(sql: Sql, table: string): Promise<number> {
  const [r] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
  return r!.n;
}

/** Query rows as a plain array (what `toEqual` compares against). */
export async function rows(q: PromiseLike<readonly object[]>): Promise<object[]> {
  return [...(await q)];
}
