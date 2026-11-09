import { describe, expect, test } from "bun:test";
import { DailyLedger } from "../src/ledger";

const DAY_MS = 86_400_000;
const T0 = Date.parse("2026-11-09T10:00:00Z");

function ledger(o: { cap?: number; tests?: number; now?: () => number } = {}) {
  return new DailyLedger({ price: 50_000n, acceptTokens: ["USDC"], dailyCap: o.cap ?? 3, freeTestsPerDay: o.tests ?? 1, now: o.now ?? (() => T0) });
}

describe("price", () => {
  test("a hire holding the price or more in USDC is paid work", () => {
    const l = ledger();
    expect(l.terms({ escrowAmount: "0.050000000000", escrowToken: "USDC" })).toEqual({ ok: true, kind: "paid" });
    expect(l.terms({ escrowAmount: "2.5", escrowToken: "usdc" })).toEqual({ ok: true, kind: "paid" });
  });

  test("less than the price, another token, or a bad amount is refused with the reason", () => {
    const l = ledger();
    expect(l.terms({ escrowAmount: "0.049999999999", escrowToken: "USDC" })).toEqual({ ok: false, reason: "this agent's price is 0.05 USDC a call; this hire holds 0.049999999999 USDC" });
    expect(l.terms({ escrowAmount: "5.000000000000", escrowToken: "USD" })).toEqual({ ok: false, reason: "this agent is paid in USDC, not USD" });
    expect(l.terms({ escrowAmount: "lots", escrowToken: "USDC" }).ok).toBe(false);
  });

  test("a hire holding nothing is a free test run, refused when the agent takes none", () => {
    expect(ledger().terms({ escrowAmount: "0", escrowToken: "USDC" })).toEqual({ ok: true, kind: "test" });
    expect(ledger({ tests: 0 }).terms({ escrowAmount: "0.000000000000", escrowToken: "USDC" })).toEqual({ ok: false, reason: "this agent takes no unpaid calls" });
  });
});

describe("daily cap", () => {
  test("takes calls up to the cap; the same assignment twice counts once", () => {
    const l = ledger({ cap: 2 });
    expect(l.take("a", "paid")).toBe(true);
    expect(l.take("a", "paid")).toBe(true);
    expect(l.take("b", "paid")).toBe(true);
    expect(l.count()).toBe(2);
    expect(l.room("paid")).toEqual({ ok: false, reason: "this agent's daily capacity (2 calls) is used up; it takes calls again after 00:00 UTC" });
    expect(l.take("c", "paid")).toBe(false);
    expect(l.has("a")).toBe(true);
    expect(l.has("c")).toBe(false);
  });

  test("free test runs have their own allowance inside the cap", () => {
    const l = ledger({ cap: 5, tests: 1 });
    expect(l.take("t1", "test")).toBe(true);
    expect(l.room("test")).toEqual({ ok: false, reason: "the day's free test runs (1) are used up" });
    expect(l.take("t2", "test")).toBe(false);
    expect(l.take("p1", "paid")).toBe(true);
    expect(l.count("test")).toBe(1);
    expect(l.count("paid")).toBe(1);
  });

  test("a new UTC day starts from zero", () => {
    let now = T0;
    const l = ledger({ cap: 1, now: () => now });
    expect(l.take("a", "paid")).toBe(true);
    expect(l.take("b", "paid")).toBe(false);
    expect(l.day).toBe("2026-11-09");
    now += DAY_MS;
    expect(l.day).toBe("2026-11-10");
    expect(l.count()).toBe(0);
    expect(l.take("b", "paid")).toBe(true);
  });

  test("seeding from the market counts only today's started assignments, once", () => {
    const l = ledger({ cap: 3 });
    const rows = [
      { assignmentId: "today-paid", startedAt: "2026-11-09T01:00:00Z", escrowAmount: "0.050000000000" },
      { assignmentId: "today-test", startedAt: "2026-11-09T02:00:00Z", escrowAmount: "0.000000000000" },
      { assignmentId: "yesterday", startedAt: "2026-11-08T23:59:59Z", escrowAmount: "0.050000000000" },
      { assignmentId: "never-started", startedAt: null, escrowAmount: "0.050000000000" },
    ];
    expect(l.seed(rows)).toBe(2);
    expect(l.seed(rows)).toBe(0);
    expect(l.count("paid")).toBe(1);
    expect(l.count("test")).toBe(1);
    expect(l.take("next", "paid")).toBe(true);
    expect(l.take("over", "paid")).toBe(false);
  });
});
