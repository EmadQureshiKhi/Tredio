import { connect, migrate, type Sql } from "../src/db";
import { log } from "../src/log";

/** Why a database test cannot run (`bun run test` skips those files instead, outside CI; see test/run.ts). */
export const DB_REQUIRED =
  "TEST_DATABASE_URL is not set: database tests need a Postgres database they may truncate, for example TEST_DATABASE_URL=postgres://localhost:5432/tredio_test";

/** A migrated, empty test database. Tests run one file at a time, so each file truncates first. */
export async function testDb(): Promise<Sql> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error(DB_REQUIRED);
  const sql = connect(url, 4);
  await migrate(sql);
  await sql`TRUNCATE ai_reviews, candidates, trend_meta, measurements, api_usage, link_requests, radar_signals, job_runs, posts, calls, callers, vault_items, push_subscriptions, cursors, revoked_tokens, owner_approvals RESTART IDENTITY CASCADE`;
  return sql;
}

export const quietLog = log.child({}, { level: "silent" });

/** A fetch stub answering from a route table; unmatched requests fail the test loudly. */
export function fakeFetch(routes: Array<[RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    const route = routes.find(([re]) => re.test(input));
    if (!route) throw new Error(`unexpected request ${input}`);
    return route[1](input, init);
  };
  return { impl, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
