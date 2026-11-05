import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/** Tables rebuilt from `events` by a resync; every other table of the schema is raw input. */
export const DERIVED_TABLES = [
  "trends",
  "index_points",
  "settlements",
  "marks",
  "oracle_runs",
  "series",
  "outcome_balances",
  "outcome_flows",
  "book_markets",
  "book_orders",
  "book_trades",
  "book_swaps",
  "perp_positions",
  "perp_funding",
  "curves",
  "coin_trades",
  "coin_balances",
  "curation",
  "curation_claims",
  "accounts",
  "sessions",
  "session_actions",
  "hyperliquid_signatures",
  "usdc_transfers",
  "usdc_mints",
] as const;

export const RAW_TABLES = ["events", "cursor"] as const;

/**
 * A client whose connections all work inside `schema`. TLS follows the URL (`sslmode=require`);
 * statements are not prepared, so a pooler in transaction mode works too.
 */
export function connect(url: string, schema: string, max = 4): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
    connection: { search_path: schema, application_name: "tredio-indexer" },
  });
}

/** Creates the schema and applies every migration in order (each one is idempotent). */
export async function migrate(sql: Sql, schema: string): Promise<string[]> {
  await sql.unsafe(`create schema if not exists "${schema}"`);
  const dir = join(import.meta.dir, "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) await sql.unsafe(readFileSync(join(dir, file), "utf8"));
  return files;
}

/**
 * Holds a session advisory lock on the schema for as long as the returned release is not
 * called, so two indexers (or an indexer and a resync) never write the same tables. Returns
 * null when another process holds it.
 */
export async function lockSchema(sql: Sql, schema: string): Promise<(() => Promise<void>) | null> {
  const conn = await sql.reserve();
  const [row] = await conn<{ ok: boolean }[]>`select pg_try_advisory_lock(hashtext(${"tredio-indexer:" + schema})) as ok`;
  if (!row?.ok) {
    conn.release();
    return null;
  }
  return async () => {
    await conn`select pg_advisory_unlock(hashtext(${"tredio-indexer:" + schema}))`.catch(() => {});
    conn.release();
  };
}
