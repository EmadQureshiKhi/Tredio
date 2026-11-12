import { describe, expect, test } from "bun:test";
import { AUTOPILOT_MARKETS } from "@tredio/autopilot";
import type { Trend } from "@tredio/contracts";
import { loadConfig } from "../src/config";
import { ENCLAVE_RETRY_MS, Oracle, retryUntil } from "../src/oracle";
import type { EnclaveOutput } from "../src/outlayer";
import { boostedPoints, normalizeCount, toIndexUnits } from "../src/index-method";
import { METHOD, measure } from "../src/method";
import { allocate, assetClassOf, type Candidate, decide, freeListing, freeSlots, type LiveTrend, payableSurfacer, reportMarks } from "../src/plan";

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

  test("a trend rotating out frees its slot for its successor, and the board is full again once it lists", () => {
    const full = [...Array.from({ length: 24 }, (_, i) => trend(`topic:t${i}`, { status: i % 2 ? "cooling" : "active" })), trend("topic:old", { status: "retired" })];
    expect(freeSlots(full, new Set(), 24)).toBe(0);
    expect(freeSlots(full, new Set(["topic:t3"]), 24)).toBe(1);
    const listed = [...full, trend("topic:new")];
    expect(freeSlots(listed, new Set(["topic:t3"]), 24)).toBe(0);
    expect(freeSlots(listed, new Set(), 24)).toBe(0);
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

describe("marks", () => {
  test("carry Hyperliquid's asset index, the universe position delisted markets keep", async () => {
    const { HyperliquidInfo } = await import("@tredio/hyperliquid");
    // Universe: BTC (0), a delisted market (1), ETH (2), kPEPE (3).
    const answer = [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "OLD", szDecimals: 0, maxLeverage: 3, isDelisted: true }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "kPEPE", szDecimals: 0, maxLeverage: 10 }] },
      [{ markPx: "65000.5" }, { markPx: "1" }, { markPx: "3000" }, { markPx: "0.0123" }],
    ];
    const info = new HyperliquidInfo("testnet", async () => new Response(JSON.stringify(answer)));
    const markets = await info.perpMarkets();
    expect(markets.map((m) => [m.symbol, m.index])).toEqual([["BTC", 0], ["ETH", 2], ["kPEPE", 3]]);
    expect(reportMarks(markets, new Set(["BTC", "ETH", "KPEPE", "SOL"]))).toEqual([
      { asset: "BTC", price: "6500050000000", asset_index: 0 },
      { asset: "ETH", price: "300000000000", asset_index: 2 },
      // Matched without regard to case, stored under Hyperliquid's own symbol, which orders name.
      { asset: "kPEPE", price: "1230000", asset_index: 3 },
    ]);
  });

  test("every report marks Autopilot's markets, from this process and from the enclave build", async () => {
    const env = { ORACLE_ACCOUNT_ID: "tredio-oracle.testnet", ORACLE_PRIVATE_KEY: "ed25519:a", REPORT_SIGNING_KEY: "ed25519:b", BACKEND_TOKEN: "t".repeat(16) };
    expect(loadConfig(env).MARK_ASSETS).toEqual([...AUTOPILOT_MARKETS]);
    expect(loadConfig({ ...env, MARK_ASSETS: "btc,eth,sol,near,hype,zec" }).MARK_ASSETS).toEqual([...AUTOPILOT_MARKETS, "ZEC"]);
    // Leaving one out would leave its rules and copies waiting on the order guard forever.
    expect(() => loadConfig({ ...env, MARK_ASSETS: "BTC,ETH" })).toThrow("MARK_ASSETS must include Autopilot's markets (BTC, ETH, SOL, NEAR and HYPE)");
    // The enclave (tee/, Rust) keeps its own list, fixed in its measured build: it must be the same one.
    const rust = await Bun.file(new URL("../tee/src/main.rs", import.meta.url)).text();
    const tee = /const MARK_ASSETS: \[&str; \d+\] = \[([^\]]*)\];/.exec(rust)?.[1];
    expect(tee?.split(",").map((s) => s.trim().replaceAll('"', ""))).toEqual([...AUTOPILOT_MARKETS]);
  });
});


describe("enclave runs", () => {
  test("a failed try is retried after each delay while the next try still fits before the deadline", async () => {
    let clock = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    let tries = 0;
    const flaky = async () => {
      tries += 1;
      if (tries < 3) throw new Error(`worker busy ${tries}`);
      return "signed";
    };
    expect(await retryUntil(flaky, { delaysMs: [3_000, 10_000], deadline: 60_000, now: () => clock, sleep })).toBe("signed");
    expect(waits).toEqual([3_000, 10_000]);

    // Out of delays: the last error comes back.
    tries = -10;
    await expect(retryUntil(flaky, { delaysMs: [1, 1], deadline: 60_000, now: () => clock, sleep })).rejects.toThrow("worker busy -7");
    // A wait that would end past the deadline is not taken: the next interval's run comes sooner.
    clock = 55_000;
    tries = 0;
    waits.length = 0;
    await expect(retryUntil(flaky, { delaysMs: [3_000, 10_000], deadline: 60_000, now: () => clock, sleep })).rejects.toThrow("worker busy 2");
    expect(waits).toEqual([3_000]);
  });

  test("the oracle counts enclave runs that failed after their retries and clears the count on the next good one", async () => {
    const none = {} as never;
    const oracle = new Oracle(none, none, null, none, none, none);
    let calls = 0;
    const outputs: EnclaveOutput[] = [];
    const enclave = {
      run: async () => {
        calls += 1;
        return { output: outputs.shift() ?? { report_json: null, error: "Execution failed: worker unavailable" }, tx: null };
      },
    };
    const sleep = async () => {};
    await expect(oracle.runEnclave(enclave, { deadline: Date.now() + 60_000, sleep })).rejects.toThrow("enclave: Execution failed: worker unavailable");
    expect(calls).toBe(1 + ENCLAVE_RETRY_MS.length);
    expect(oracle.enclaveFailures).toBe(1);
    await expect(oracle.runEnclave(enclave, { deadline: Date.now() + 60_000, sleep })).rejects.toThrow();
    expect(oracle.enclaveFailures).toBe(2);
    expect(oracle.enclaveOkAt).toBeNull();

    // One failure, then a run with nothing to report: it counts as good and nothing is submitted.
    calls = 0;
    outputs.push({ report_json: null, error: "Execution failed: timeout" }, { report_json: null });
    const result = await oracle.runEnclave(enclave, { deadline: Date.now() + 60_000, sleep });
    expect(result.skipped).toBe("nothing to report");
    expect(calls).toBe(2);
    expect(oracle.enclaveFailures).toBe(0);
    expect(oracle.enclaveOkAt).not.toBeNull();
  });
});
