import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Sql } from "../src/db";
import { Dispatcher } from "../src/notify/dispatcher";
import type { Push, PushPayload, Topic } from "../src/notify/push";
import { testDb } from "./helpers";

/**
 * Resolved calls notify their caller once each, in whatever order they resolve: a 7-day call made
 * before a 24-hour one resolves after it, and still buzzes. Hidden calls stay quiet.
 */

const [ALICE, BOB] = ["a", "b"].map((ch) => ch.repeat(64)) as [string, string];
let sql: Sql;
let sent: Array<{ account: string; topic: Topic; payload: PushPayload }> = [];
const push = { enabled: true, notify: async (account: string, topic: Topic, payload: PushPayload) => (sent.push({ account, topic, payload }), 1) } as unknown as Push;

beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE calls, callers RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO callers (address, linked_account) VALUES (${ALICE}, 'alice.testnet'), (${BOB}, NULL)`;
  sent = [];
});

let signatures = 0;
async function call(caller: string, horizon: number) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO calls (caller, identifier, trend_id, direction, horizon_sec, signature, called_at, opening_index, resolves_at, outcome)
    VALUES (${caller}, 'topic:openai', 'topic:openai', 'up', ${horizon}, ${`sig-${++signatures}`}, 1790000000, 50, ${1790000000 + horizon}, 'open')
    RETURNING id`;
  return Number(row!.id);
}
const resolve = (id: number, outcome: "hit" | "miss") => sql`UPDATE calls SET outcome = ${outcome} WHERE id = ${id}`;

test("a call that resolves after a newer one still notifies, once", async () => {
  const week = await call(ALICE, 7 * 86_400);
  const day = await call(ALICE, 86_400);
  const d = new Dispatcher(sql, push);
  await resolve(day, "hit");
  await d.tick();
  expect(sent.map((s) => s.payload.tag)).toEqual([`call-${day}`]);
  await resolve(week, "miss");
  await d.tick();
  await d.tick();
  expect(sent.map((s) => s.payload.tag)).toEqual([`call-${day}`, `call-${week}`]);
  expect(sent[1]!).toMatchObject({ account: "alice.testnet", topic: "calls", payload: { title: "Your call missed" } });
});

test("hidden calls, unlinked callers and void calls stay quiet, and are not asked again", async () => {
  const hidden = await call(ALICE, 86_400);
  const unlinked = await call(BOB, 86_400);
  const voided = await call(ALICE, 86_400);
  await sql`UPDATE calls SET hidden_at = now() WHERE id = ${hidden}`;
  await resolve(hidden, "hit");
  await resolve(unlinked, "hit");
  await sql`UPDATE calls SET outcome = 'void' WHERE id = ${voided}`;
  await new Dispatcher(sql, push).tick();
  expect(sent).toEqual([]);
  const left = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calls WHERE outcome <> 'open' AND notified_at IS NULL`;
  expect(left[0]!.n).toBe(0);
});
