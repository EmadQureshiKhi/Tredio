import { describe, expect, test } from "bun:test";
import type { Trend } from "@tredio/contracts";
import { boostedPoints, normalizeCount, toIndexUnits } from "../src/index-method";
import { METHOD, measure } from "../src/method";
import { allocate, assetClassOf, type Candidate, decide, freeListing, type LiveTrend, payableSurfacer } from "../src/plan";

const NOW = 1_793_900_000;
const reading = (value: number, ageSec = 60) => ({ value, windowSec: 86_400, observedAt: NOW - ageSec });

describe("index method", () => {
  test("log scale up to saturation, clipped", () => {
    expect(normalizeCount(0, 10_000, 5_000, 1)).toBe(0);
    expect(normalizeCount(5_000, 10_000, 5_000, 1)).toBeCloseTo(1);
    expect(normalizeCount(1e9, 10_000, 5_000, 1)).toBe(1);
    expect(toIndexUnits(0)).toBe(10_000n);
    expect(toIndexUnits(42.346)).toBe(42_350_000n);
  });

  test("a boost only lifts", () => {
    const base = [{ value: 0.5, weight: 1 }];
    expect(boostedPoints(base, [{ value: 0.1, weight: 1 }])).toBe(50);
    expect(boostedPoints(base, [{ value: 0.9, weight: 1 }])).toBe(70);
  });

  test("stale readings drop out; smart money needs an attention source; weights renormalize", () => {
    const m = measure({ elfa: reading(5000), bluesky: reading(1000, 99_999) }, false, NOW);
    expect(m.points).toBe(100);
    expect(m.sources).toEqual(["elfa"]);
    expect(measure({ nansen: reading(1e9) }, true, NOW).points).toBeNull();
    const withFlow = measure({ elfa: reading(5000), nansen: reading(-1e9) }, true, NOW);
    expect(withFlow.points).toBeCloseTo((100 * 0.6) / 0.8, 1);
    expect(withFlow.netflowUsd).toBe(-1e9);
    expect(METHOD.elfa.weight).toBe(0.6);
  });
});

const trend = (id: string, over: Partial<LiveTrend> = {}): LiveTrend => ({
  id,
  asset_class: "topic",
  status: "active",
  created_at: NOW - 3600,
  updated_at: NOW - 60,
  index: 50_000_000,
  peak_index: 50_000_000,
  below_floor_since: 0,
  status_since: NOW - 3600,
  surfacer: null,
  review_hash: null,
  asset: null,
  fresh: true,
  pendingDue: 0,
  ...over,
});
const cand = (identifier: string, over: Partial<Candidate> = {}): Candidate => ({ identifier, surfacer: null, ticker: null, reviewHash: null, pinned: false, pick: false, ...over });
const params = { now: NOW, heartbeatSec: 420, deviationBps: 100, minCreateIndexPoints: 5, minConfirmNetflowUsd: 100_000, hyperliquidAssets: new Set(["BTC"]) };
const m = (points: number | null, netflowUsd: number | null = null) => ({ points, netflowUsd, sources: [] });

describe("planning a run", () => {
  test("pending settlements first, then candidates while slots are free, then the oldest", () => {
    const live = [trend("a", { updated_at: NOW - 10 }), trend("b", { updated_at: NOW - 500 }), trend("c", { pendingDue: 1 })];
    const s = allocate(live, [cand("topic:x"), cand("topic:y")], 3, 1, 5);
    expect(s.trends.map((t) => t.id)).toEqual(["c", "b"]);
    expect(s.candidates.map((c) => c.identifier)).toEqual(["topic:x"]);
    expect(allocate(live, [cand("topic:x")], 3, 1, 0).candidates).toEqual([]);
  });

  test("versions: the base, then .2 once retired; none while one is live", () => {
    const statuses = new Map<string, Trend["status"]>([["topic:a", "retired"], ["topic:b", "active"]]);
    expect(freeListing("topic:a", (id) => statuses.get(id) ?? null)).toBe("topic:a.2");
    expect(freeListing("topic:b", (id) => statuses.get(id) ?? null)).toBeNull();
    expect(freeListing("topic:c", (id) => statuses.get(id) ?? null)).toBe("topic:c");
  });

  test("updates on heartbeat, deviation or a pending settlement; riders join only a report that goes out", () => {
    const d = decide(
      [
        { trend: trend("quiet", { updated_at: NOW - 60 }), m: m(50.2) },
        { trend: trend("moved", { updated_at: NOW - 60 }), m: m(60) },
        { trend: trend("half", { updated_at: NOW - 300 }), m: m(50) },
        { trend: trend("due", { updated_at: NOW - 30, pendingDue: 1 }), m: m(50) },
      ],
      [],
      params,
    );
    expect(d.updates.map((u) => u.id)).toEqual(["moved", "due", "half"]);
    expect(decide([{ trend: trend("half", { updated_at: NOW - 300 }), m: m(50) }], [], params).updates).toEqual([]);
  });

  test("new trends: above the minimum, crypto only on inflow or a pin, assets only when Hyperliquid lists them", () => {
    const d = decide(
      [],
      [
        { candidate: cand("topic:low"), identifier: "topic:low", m: m(3) },
        { candidate: cand("crypto:btc", { ticker: "btc", reviewHash: "a".repeat(64), surfacer: "alice.testnet" }), identifier: "crypto:btc", m: m(40, 200_000) },
        { candidate: cand("crypto:pepe", { ticker: "pepe" }), identifier: "crypto:pepe", m: m(40, 0) },
        { candidate: cand("crypto:doge", { ticker: "doge", pinned: true, surfacer: "radar" }), identifier: "crypto:doge.2", m: m(40, null) },
      ],
      params,
    );
    expect(d.new_trends).toEqual([
      { identifier: "crypto:btc", asset_class: "crypto", index: 40_000_000, surfacer: "alice.testnet", smart_money_confirmed: true, review_hash: "a".repeat(64), asset: "BTC" },
      { identifier: "crypto:doge.2", asset_class: "crypto", index: 40_000_000, surfacer: null, smart_money_confirmed: true, review_hash: null, asset: null },
    ]);
  });

  test("identifiers and surfacers", () => {
    expect(assetClassOf("person:taylor-swift")).toBe("person");
    expect(assetClassOf("world-cup")).toBe("topic");
    expect(payableSurfacer("radar")).toBeNull();
    expect(payableSurfacer("alice.testnet")).toBe("alice.testnet");
    expect(payableSurfacer(`0u${"a".repeat(52)}`)).toBe(`0u${"a".repeat(52)}`);
  });
});
