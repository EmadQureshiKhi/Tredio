import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyRing, keyId, REJECTED_KEY_MS, THROTTLED_KEY_MS } from "../src/budget";
import type { Sql } from "../src/db";
import { testDb } from "./helpers";

let sql: Sql;
beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});

describe("KeyRing", () => {
  test("spreads reservations over the key with the most left and persists them", async () => {
    const now = () => new Date("2026-10-10T12:00:00Z");
    const ring = new KeyRing(sql, "t1", ["a", "b"], { daily: 3 }, now);
    const picked = [];
    for (let i = 0; i < 6; i++) picked.push((await ring.take())?.key);
    expect(picked.sort()).toEqual(["a", "a", "a", "b", "b", "b"]);
    expect(await ring.take()).toBeNull();
    // A new process sees the same usage.
    expect(await new KeyRing(sql, "t1", ["a", "b"], { daily: 3 }, now).take()).toBeNull();
    // Tomorrow the keys pay again.
    expect(await new KeyRing(sql, "t1", ["a", "b"], { daily: 3 }, () => new Date("2026-10-11T00:00:01Z")).take()).not.toBeNull();
  });

  test("paces a monthly allowance across the days left", async () => {
    // October 10: 22 days left including today, 950 credits: 43 a day.
    const ring = new KeyRing(sql, "t2", ["k"], { daily: 100, monthly: 950 }, () => new Date("2026-10-10T08:00:00Z"));
    expect((await ring.usage())[0]!.left).toBe(43);
    expect(await ring.take(43)).not.toBeNull();
    expect(await ring.take(1)).toBeNull();
    // Spending ahead of pace earlier in the month shrinks today's share: 50 credits over 12 days.
    await sql`INSERT INTO api_usage (provider, key_id, day, credits) VALUES ('t3', ${keyId("k")}, '2026-10-15', 900)`;
    const later = new KeyRing(sql, "t3", ["k"], { daily: 100, monthly: 950 }, () => new Date("2026-10-20T08:00:00Z"));
    expect((await later.usage())[0]).toMatchObject({ today: 0, month: 900, left: 4 });
  });

  test("syncs usage the provider reports into today", async () => {
    const ring = new KeyRing(sql, "t7", ["k"], { daily: 100, monthly: 950 }, () => new Date("2026-10-20T08:00:00Z"));
    await ring.syncMonth(keyId("k"), 120);
    await ring.syncMonth(keyId("k"), 100);
    expect((await ring.usage())[0]).toMatchObject({ month: 120 });
  });

  test("never charges a cost larger than what a key has left", async () => {
    const ring = new KeyRing(sql, "t4", ["k"], { daily: 10 }, () => new Date("2026-10-10T08:00:00Z"));
    expect(await ring.take(6)).not.toBeNull();
    expect(await ring.take(5)).toBeNull();
    expect(await ring.take(4)).not.toBeNull();
  });

  test("benches an exhausted key until the next UTC day", async () => {
    let t = new Date("2026-10-10T23:00:00Z");
    const ring = new KeyRing(sql, "t5", ["a", "b"], { daily: 10 }, () => t);
    const first = await ring.take();
    ring.exhaust(first!.keyId);
    for (let i = 0; i < 5; i++) expect((await ring.take())?.keyId).not.toBe(first!.keyId);
    t = new Date("2026-10-11T00:00:01Z");
    const keys = new Set<string>();
    for (let i = 0; i < 4; i++) keys.add((await ring.take())!.keyId);
    expect(keys.has(first!.keyId)).toBe(true);
  });

  test("a rejected key sits out for hours, then is tried again", async () => {
    let t = new Date("2026-10-10T08:00:00Z");
    const ring = new KeyRing(sql, "t7", ["a", "b"], { daily: 10 }, () => t);
    const ids = (await ring.usage()).map((u) => u.keyId);
    ring.reject(ids[0]!);
    for (let i = 0; i < 4; i++) expect((await ring.take())?.keyId).toBe(ids[1]!);
    expect(await ring.leftToday()).toBe(6);
    t = new Date(t.getTime() + REJECTED_KEY_MS + 1000);
    expect((await ring.take())?.keyId).toBe(ids[0]!);
  });

  test("a throttled key rests for a minute, never shortening a longer bench", async () => {
    let t = new Date("2026-10-10T08:00:00Z");
    const ring = new KeyRing(sql, "t8", ["a", "b"], { daily: 10 }, () => t);
    const ids = (await ring.usage()).map((u) => u.keyId);
    ring.rest(ids[0]!);
    expect((await ring.take())?.keyId).toBe(ids[1]!);
    t = new Date(t.getTime() + THROTTLED_KEY_MS + 1);
    expect(new Set([(await ring.take())?.keyId, (await ring.take())?.keyId]).has(ids[0]!)).toBe(true);
    ring.reject(ids[1]!);
    ring.rest(ids[1]!);
    t = new Date(t.getTime() + THROTTLED_KEY_MS + 1);
    for (let i = 0; i < 3; i++) expect((await ring.take())?.keyId).toBe(ids[0]!);
  });

  test("concurrent reservations never overspend", async () => {
    const ring = new KeyRing(sql, "t6", ["a", "b", "c"], { daily: 5 }, () => new Date("2026-10-10T08:00:00Z"));
    const results = await Promise.all(Array.from({ length: 30 }, () => ring.take()));
    expect(results.filter(Boolean)).toHaveLength(15);
  });

  test("stores fingerprints, never keys", async () => {
    const rows = await sql<{ key_id: string }[]>`SELECT DISTINCT key_id FROM api_usage`;
    for (const r of rows) expect(r.key_id).toMatch(/^[0-9a-f]{12}$/);
  });
});
