import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyRing, keyId } from "../src/budget";
import type { Sql } from "../src/db";
import { Elfa } from "../src/sources/elfa";
import { BudgetError } from "../src/sources/http";
import { CallPacer, PacedError } from "../src/sources/pacer";
import { fakeFetch, json, testDb } from "./helpers";

let sql: Sql;
beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});

/** A clock that only moves when a wait asks it to. */
function clock(start = Date.UTC(2026, 9, 13, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const opts = { minGapMs: 20_000, maxGapMs: 90_000, keyGapMs: 600_000, keyJitter: 0.3 };
const mentionsOk = () => json({ success: true, data: [], metadata: { total: 3 } });
const keyOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.["x-elfa-api-key"];

describe("CallPacer", () => {
  test("runs calls one at a time with a gap between the configured bounds after each", async () => {
    const c = clock();
    const starts: number[] = [];
    const ends: number[] = [];
    const pacer = new CallPacer("t", opts, c.now, () => 0.5, c.sleep);
    const call = async () => {
      starts.push(c.now());
      c.advance(1000);
      ends.push(c.now());
    };
    await Promise.all([pacer.run(call, true), pacer.run(call, true), pacer.run(call, true)]);
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - ends[i - 1]!).toBe(55_000);
  });

  test("gaps stay within their bounds for any draw", () => {
    for (const r of [0, 0.25, 0.999]) {
      const pacer = new CallPacer("t", opts, () => 0, () => r);
      const g = pacer.gap();
      expect(g).toBeGreaterThanOrEqual(opts.minGapMs);
      expect(g).toBeLessThanOrEqual(opts.maxGapMs);
    }
  });

  test("a caller that cannot wait is told when the next call is due instead of queueing", async () => {
    const c = clock();
    const pacer = new CallPacer("t", opts, c.now, () => 0, c.sleep);
    await pacer.run(async () => undefined, true);
    expect(pacer.waitMs()).toBe(20_000);
    await expect(pacer.run(async () => undefined, false)).rejects.toBeInstanceOf(PacedError);
    c.advance(20_000);
    expect(pacer.waitMs()).toBe(0);
    await pacer.run(async () => undefined, false);
  });

  test("a call in flight makes the next one not due", async () => {
    const c = clock();
    const pacer = new CallPacer("t", opts, c.now, () => 0, c.sleep);
    let release!: () => void;
    const running = pacer.run(() => new Promise<void>((r) => (release = r)), true);
    await Promise.resolve();
    expect(pacer.waitMs()).toBeGreaterThan(0);
    release();
    await running;
  });

  test("a key rests for its jittered gap after each use", () => {
    for (const [r, expected] of [
      [0, 420_000],
      [0.5, 600_000],
      [1, 780_000],
    ] as const) {
      const c = clock();
      const pacer = new CallPacer("t", opts, c.now, () => r);
      pacer.used("k");
      expect(pacer.keyReady("k")).toBe(false);
      expect(pacer.keyWaitMs("k")).toBe(expected);
      c.advance(expected);
      expect(pacer.keyReady("k")).toBe(true);
    }
  });

  test("refuses gap bounds that cannot work", () => {
    expect(() => new CallPacer("t", { ...opts, minGapMs: 10, maxGapMs: 5 })).toThrow();
    expect(() => new CallPacer("t", { ...opts, keyJitter: 1 })).toThrow();
  });
});

describe("KeyRing hourly release", () => {
  test("a key may spend only its share of the day so far, plus slack", async () => {
    let at = new Date("2026-10-13T00:30:00Z");
    const ring = new KeyRing(sql, "pace-a", ["only"], { daily: 48, hourlySlack: 1 }, () => at);
    // Hour 0: 48 * 1/24 = 2, plus 1 slack.
    expect((await ring.usage())[0]!.left).toBe(3);
    for (let i = 0; i < 3; i++) expect(await ring.take(1)).not.toBeNull();
    expect(await ring.take(1)).toBeNull();
    at = new Date("2026-10-13T05:10:00Z");
    // Hour 5: 48 * 6/24 = 12, plus 1, minus the 3 spent.
    expect((await ring.usage())[0]!.left).toBe(10);
    // The full day still counts toward the collector's planning.
    expect(await ring.dailyAllowance()).toBe(48);
  });

  test("a custom choice picks among the ready keys", async () => {
    const at = new Date("2026-10-13T12:00:00Z");
    const ring = new KeyRing(sql, "pace-b", ["a", "b", "c"], { daily: 10 }, () => at);
    const lease = await ring.take(1, () => true, (ready) => ready.find((u) => u.keyId === keyId("c"))!);
    expect(lease?.key).toBe("c");
  });
});

describe("Elfa with a pacer", () => {
  test("a call that is not due throws PacedError before spending a credit", async () => {
    const c = clock();
    const ring = new KeyRing(sql, "pace-c", ["k1", "k2"], { daily: 30 }, () => new Date(c.now()));
    const f = fakeFetch([[/keyword-mentions/, mentionsOk]]);
    const pacer = new CallPacer("elfa", opts, c.now, () => 0, c.sleep);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, () => null, false, { pacer, random: () => 0, sleep: c.sleep });
    expect(await elfa.mentions(["x"], 0, 86_400)).toBe(3);
    const spent = (await ring.usage()).reduce((a, u) => a + u.today, 0);
    await expect(elfa.mentions(["x"], 0, 86_400)).rejects.toBeInstanceOf(PacedError);
    expect((await ring.usage()).reduce((a, u) => a + u.today, 0)).toBe(spent);
    expect(f.calls).toHaveLength(1);
  });

  test("consecutive calls use different keys while the last one rests, and wait for a rested key when all rest", async () => {
    const c = clock();
    const ring = new KeyRing(sql, "pace-d", ["k1", "k2"], { daily: 30 }, () => new Date(c.now()));
    const f = fakeFetch([[/keyword-mentions/, mentionsOk]]);
    const pacer = new CallPacer("elfa", opts, c.now, () => 0, c.sleep);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, () => null, false, { pacer, random: () => 0, sleep: c.sleep });
    for (let i = 0; i < 3; i++) await elfa.mentions(["x"], 0, 86_400, true);
    const keys = f.calls.map((x) => keyOf(x.init));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
    // The third call had to wait for the first key's rest (420 s at the lowest draw).
    expect(c.now() - Date.UTC(2026, 9, 13, 12, 0, 0)).toBeGreaterThanOrEqual(420_000);
  });

  test("a weighted draw prefers the key with more credits left", async () => {
    const c = clock();
    const ring = new KeyRing(sql, "pace-e", ["rich", "poor"], { daily: 30 }, () => new Date(c.now()));
    // Spend most of "poor" up front.
    for (let i = 0; i < 25; i++) await ring.take(1, (id) => id === keyId("poor"));
    const f = fakeFetch([[/keyword-mentions/, mentionsOk]]);
    const pacer = new CallPacer("elfa", opts, c.now, () => 0, c.sleep);
    // A draw at 0.5 of 35 credits (30 + 5) lands on "rich".
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, () => null, false, { pacer, random: () => 0.5, sleep: c.sleep });
    await elfa.mentions(["x"], 0, 86_400, true);
    expect(keyOf(f.calls[0]!.init)).toBe("rich");
  });

  test("rejected keys are benched after one try each, spaced apart, with no burst", async () => {
    const c = clock();
    const ring = new KeyRing(sql, "pace-f", ["dead1", "dead2"], { daily: 30 }, () => new Date(c.now()));
    const at: number[] = [];
    const f = fakeFetch([
      [
        /keyword-mentions/,
        () => {
          at.push(c.now());
          return json({ code: "ERR_UNAUTHORIZED", message: "Invalid or expired API key" }, 401);
        },
      ],
    ]);
    const pacer = new CallPacer("elfa", opts, c.now, () => 0, c.sleep);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, () => null, false, { pacer, random: () => 0, sleep: c.sleep });
    await expect(elfa.mentions(["x"], 0, 86_400, true)).rejects.toBeInstanceOf(BudgetError);
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(opts.minGapMs);
    expect(elfa.keysBenched).toBe(true);
  });

  test("a key check goes one key at a time, a gap apart, reporting each result as it lands", async () => {
    const c = clock();
    const ring = new KeyRing(sql, "pace-g", ["a", "b", "c"], { daily: 30 }, () => new Date(c.now()));
    const at: number[] = [];
    const f = fakeFetch([
      [
        /key-status/,
        () => {
          at.push(c.now());
          return json({ success: true, data: { status: "active", monthlyRequestLimit: 1000 } });
        },
      ],
    ]);
    const pacer = new CallPacer("elfa", opts, c.now, () => 0, c.sleep);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, () => null, false, { pacer, checkGapMs: [30_000, 90_000], random: () => 0, sleep: c.sleep });
    const progress: number[] = [];
    const out = await elfa.checkKeys(
      ["a", "b", "c"].map((k) => ({ key: k, keyId: keyId(k) })),
      (done) => progress.push(done.length),
    );
    expect(out.map((r) => r.outcome)).toEqual(["ok", "ok", "ok"]);
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(30_000);
    expect(progress).toEqual([1, 2, 3]);
  });
});
