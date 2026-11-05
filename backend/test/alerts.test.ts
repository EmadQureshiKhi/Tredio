import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { alertPayload, Alerts, checkAlert } from "../src/alerts";
import type { ChainTrend } from "../src/chain";
import type { Sql } from "../src/db";
import type { IndexPoint } from "../src/history";
import type { Push, PushPayload, Topic } from "../src/notify/push";
import { testDb } from "./helpers";

const T = 1_792_000_000;
// One point a minute for two hours: flat at 40, then a climb to 50 in the last 30 minutes.
const climb: IndexPoint[] = Array.from({ length: 121 }, (_, i) => ({ t: T - (120 - i) * 60, v: i < 90 ? 40 : 40 + ((i - 90) / 30) * 10 }));
const base = { changePct: null, windowMin: null, level: null, armed: true, lastFiredAt: null };

describe("checkAlert", () => {
  test("a rise fires when the index climbed by the percentage within the window, and rests a window after", () => {
    const rise = { ...base, kind: "rise" as const, changePct: 20, windowMin: 60 };
    expect(checkAlert(rise, climb, T)).toMatchObject({ fire: true, value: 50 });
    expect(checkAlert({ ...rise, changePct: 30 }, climb, T).fire).toBe(false);
    // A 15-minute window sees only half the climb.
    expect(checkAlert({ ...rise, windowMin: 15 }, climb, T).fire).toBe(false);
    expect(checkAlert({ ...rise, lastFiredAt: new Date((T - 600) * 1000) }, climb, T).fire).toBe(false);
    expect(checkAlert({ ...rise, lastFiredAt: new Date((T - 3_600) * 1000) }, climb, T).fire).toBe(true);
    expect(checkAlert({ ...rise, kind: "drop" }, climb, T).fire).toBe(false);
  });

  test("a crossing fires once, then re-arms only back on the near side", () => {
    const above = { ...base, kind: "above" as const, level: 45 };
    expect(checkAlert(above, climb, T)).toMatchObject({ fire: true, armed: false });
    expect(checkAlert({ ...above, armed: false }, climb, T)).toMatchObject({ fire: false, armed: false });
    // Back under the level: re-armed, no push.
    expect(checkAlert({ ...above, armed: false }, climb, T - 60 * 60)).toMatchObject({ fire: false, armed: true });
    expect(checkAlert({ ...above, kind: "below", level: 42 }, climb, T)).toMatchObject({ fire: false, armed: true });
  });

  test("no index yet, no alert", () => {
    expect(checkAlert({ ...base, kind: "above", level: 10 }, [], T).fire).toBe(false);
  });

  test("the push names the move and links the live listing", () => {
    const p = alertPayload({ id: 7, kind: "rise", changePct: 20, windowMin: 60, level: null }, "Ethereum", "crypto:eth.3", { fire: true, armed: true, value: 50, change: 25 });
    expect(p).toEqual({ title: "Ethereum attention up 25% in 1 hour", body: "The index is at 50.0. Your alert fired.", url: "/t/crypto:eth.3", tag: "alert-7" });
    expect(alertPayload({ id: 8, kind: "below", changePct: null, windowMin: null, level: 30 }, "Ethereum", "crypto:eth.3", { fire: true, armed: false, value: 29.4, change: null }).title).toBe("Ethereum attention fell below 30");
  });
});

describe("Alerts job", () => {
  let sql: Sql;
  const sent: Array<{ account: string; topic: Topic; payload: PushPayload }> = [];
  const push = { enabled: true, notify: async (account: string, topic: Topic, payload: PushPayload) => (sent.push({ account, topic, payload }), 1) } as unknown as Push;
  const trend = (identifier: string, over: Partial<ChainTrend> = {}): ChainTrend => ({
    id: `trend-${identifier}`,
    identifier,
    assetClass: 0,
    status: "Active",
    createdAt: T - 86_400,
    updatedAt: T,
    statusSince: T - 86_400,
    index: 50,
    peakIndex: 50,
    surfacer: "radar",
  reviewHash: null,
  asset: null,
    ...over,
  });
  beforeAll(async () => {
    sql = await testDb();
  });
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    sent.length = 0;
    await sql`TRUNCATE attention_alerts RESTART IDENTITY`;
  });

  test("checks the topic's newest live listing, pushes under the alerts topic, and remembers it fired", async () => {
    let asked = "";
    const alerts = new Alerts(
      sql,
      push,
      async () => [trend("crypto:eth.2", { status: "Retired", createdAt: T - 900_000 }), trend("crypto:eth.3")],
      async (id) => ((asked = id), climb),
      async () => new Map([["crypto:eth.3", "Ethereum"]]),
    );
    await alerts.create("Account-1", { base: "crypto:eth", kind: "rise", changePct: 20, windowMin: 60, level: null, armed: true });
    await alerts.create("account-1", { base: "topic:gone", kind: "above", changePct: null, windowMin: null, level: 10, armed: true });
    expect(await alerts.tick(T)).toEqual({ checked: 1, fired: 1 });
    expect(asked).toBe(trend("crypto:eth.3").id);
    expect(sent).toEqual([{ account: "account-1", topic: "alerts", payload: expect.objectContaining({ title: "Ethereum attention up 25% in 1 hour", url: "/t/crypto:eth.3" }) }]);
    const [stored] = await alerts.list("account-1").then((l) => l.filter((a) => a.base === "crypto:eth"));
    expect(stored).toMatchObject({ firedCount: 1 });
    // Within its window it stays quiet.
    expect(await alerts.tick(T + 60)).toEqual({ checked: 1, fired: 0 });
    expect(await alerts.remove("account-2", stored!.id)).toBe(false);
    expect(await alerts.remove("account-1", stored!.id)).toBe(true);
  });
});
