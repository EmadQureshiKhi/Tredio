import { describe, expect, test } from "bun:test";
import { deployment, type Series, type Trend } from "@tredio/contracts";
import { plan } from "../src/plan";
import type { Snapshot } from "../src/snapshot";

const D = deployment("testnet");
const NOW = 1_793_900_000;
const params = { staleness_limit: 900, max_move_bps: 5000, attention_floor: 5_000_000, cooling_window: 3600, retire_window: 7200, stale_retire_window: 21_600, settlement_tolerance: 600, max_report_age: 600, max_future_skew: 60 };
const trend = (id: string, over: Partial<Trend> = {}): Trend => ({
  id,
  asset_class: "topic",
  status: "active",
  created_at: NOW - 3600,
  updated_at: NOW - 60,
  index: 50_000_000,
  peak_index: 60_000_000,
  below_floor_since: 0,
  status_since: NOW - 3600,
  surfacer: null,
  review_hash: null,
  asset: null,
  fresh: true,
  ...over,
});
const series = (id: number, over: Partial<Series> = {}): Series => ({ id, trend: "topic:a", window: 86_400, number: 1, opened_at: NOW - 100, expiry: NOW + 86_300, opening_index: 50_000_000, settlement_index: null, outcome: "open", up_supply: "0", down_supply: "0", backing: "0", ...over });
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ now: NOW, params, windows: [86_400, 604_800, 900], trends: [], latest: [], unlisted: [], expiredMarkets: [], positions: [], perpMarkets: [], curves: [], ...over });
const cfg = { seriesWindows: [86_400, 604_800], coins: true, settleDelaySec: 30 };
const kinds = (s: Snapshot) => plan(s, D, cfg).map((a) => a.key);

describe("keeper plan", () => {
  test("opens a first series per window and a coin for a fresh active trend", () => {
    expect(kinds(snap({ trends: [trend("topic:a")], latest: [{ trend: "topic:a", window: 86_400, series: null }, { trend: "topic:a", window: 604_800, series: null }, { trend: "topic:a", window: 900, series: null }] }))).toEqual([
      "openSeries:topic:a:86400",
      "openSeries:topic:a:604800",
      "createCurve:topic:a",
    ]);
  });

  test("settles after the delay, then opens the next series; stale or cooling trends open nothing", () => {
    const expired = series(7, { expiry: NOW - 31 });
    expect(kinds(snap({ trends: [trend("topic:a")], latest: [{ trend: "topic:a", window: 86_400, series: expired }], curves: [{ trend: "topic:a" } as never] }))).toEqual(["settle:7", "openSeries:topic:a:86400"]);
    expect(kinds(snap({ trends: [trend("topic:a")], latest: [{ trend: "topic:a", window: 86_400, series: series(7, { expiry: NOW - 10 }) }], curves: [{ trend: "topic:a" } as never] }))).toEqual(["openSeries:topic:a:86400"]);
    expect(kinds(snap({ trends: [trend("topic:a", { updated_at: NOW - 1000 })], latest: [{ trend: "topic:a", window: 86_400, series: null }] }))).toEqual([]);
    expect(kinds(snap({ trends: [trend("topic:a", { status: "cooling" })], latest: [{ trend: "topic:a", window: 86_400, series: null }] }))).toEqual([]);
  });

  test("liquidations first, retirements of stale and cooled-out trends, graduations, listings and pokes", () => {
    const s = snap({
      trends: [trend("topic:a", { updated_at: NOW - 21_600 }), trend("topic:b", { status: "cooling", status_since: NOW - 7200 }), trend("topic:c", { status: "retired" })],
      positions: [
        { id: 1, owner: "x", trend: "topic:c", is_long: true, entry_index: 1, qty: "1", margin: "1", entry_funding: "0", opened_at: 0, state: { liquidatable: false } as never },
        { id: 2, owner: "y", trend: "topic:a", is_long: true, entry_index: 1, qty: "1", margin: "1", entry_funding: "0", opened_at: 0, state: { liquidatable: true, equity: "0" } as never },
      ],
      curves: [{ trend: "topic:a", stage: "ready" } as never, { trend: "topic:b", stage: "open" } as never],
      unlisted: [9],
      perpMarkets: [{ trend: "topic:a", market: { long_qty: "1", short_qty: "0", cum_long: "0", cum_short: "0", last_time: 0, last_mark: 1 } }],
      expiredMarkets: [{ series: 3, side: "up" }],
    });
    expect(kinds(s)).toEqual(["liquidate:2", "settleRetired:1", "graduate:topic:a:ready", "retire:topic:a", "retire:topic:b", "list:9", "poke:topic:a", "cancelExpired:3:up"]);
  });
});
