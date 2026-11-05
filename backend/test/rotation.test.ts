import { describe, expect, test } from "bun:test";
import type { ChainTrend } from "../src/chain";
import { pickRotation, type RotationRules } from "../src/rotation";
import type { Candidate, Reading, SourceName } from "../src/store";

const NOW = 1_791_720_000;
const HOUR = 3600;
const rules: RotationRules = { maxLive: 4, minAgeSec: 36 * HOUR, fadeRatio: 0.6 };

const trend = (identifier: string, index: number, peakIndex: number, ageHours: number, status: ChainTrend["status"] = "Active"): ChainTrend => ({
  id: `trend-${identifier}`,
  identifier,
  assetClass: 6,
  status,
  createdAt: NOW - ageHours * HOUR,
  updatedAt: NOW - 60,
  statusSince: NOW - ageHours * HOUR,
  index,
  peakIndex,
  surfacer: "radar",
});

const candidate = (identifier: string): Candidate => ({
  id: 1,
  identifier,
  displayName: identifier,
  assetClass: 6,
  keywords: [],
  article: null,
  ticker: null,
  summary: null,
  source: "bluesky_trend",
  sourceRef: {},
  surfacer: "radar",
  status: "approved",
  confidence: 0.9,
  ai: {},
  decidedBy: "radar",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const mentions = (n: number): Partial<Record<SourceName, Reading>> => ({ elfa: { value: n, windowSec: 86_400, observedAt: NOW - 600 } });

/** Four live trends; `topic:faded.2` is old, at 30% of its peak and below the median. */
const board = () => [
  trend("topic:strong", 80, 90, 72),
  trend("topic:steady", 60, 70, 72),
  trend("topic:fresh", 20, 60, 12),
  trend("topic:faded.2", 15, 50, 48),
];
const latest = new Map([
  ["topic:strong", mentions(5_000)],
  ["topic:steady", mentions(3_000)],
  ["topic:fresh", mentions(400)],
  ["topic:faded", mentions(200)],
  ["topic:new", mentions(2_500)],
]);
const ready = [candidate("topic:new")];

describe("rotation", () => {
  test("a full board swaps the faded trend for a stronger candidate", () => {
    const pick = pickRotation(board(), ready, latest, new Set(), rules, NOW);
    expect(pick?.trend.identifier).toBe("topic:faded.2");
    expect(pick?.replacement.identifier).toBe("topic:new");
    expect(pick?.reason).toContain("30% of its 50.0 peak");
  });

  test("nothing rotates while a slot is free, or with nothing waiting", () => {
    expect(pickRotation(board().slice(1), ready, latest, new Set(), rules, NOW)).toBeNull();
    expect(pickRotation(board(), [], latest, new Set(), rules, NOW)).toBeNull();
  });

  test("a trend live under 36 hours stays, however far it fell", () => {
    // topic:fresh is at a third of its peak and lowest after the faded one, but only 12 hours old.
    const b = board().filter((t) => t.identifier !== "topic:faded.2").concat(trend("topic:old", 70, 75, 100));
    expect(pickRotation(b, ready, latest, new Set(), rules, NOW)).toBeNull();
  });

  test("a trend still above 60% of its peak stays, even if old and low", () => {
    const b = board().map((t) => (t.identifier === "topic:faded.2" ? trend("topic:faded.2", 15, 20, 48) : t));
    expect(pickRotation(b, ready, latest, new Set(), rules, NOW)).toBeNull();
  });

  test("a trend at or above the median stays", () => {
    const b = [trend("topic:a", 30, 100, 48), trend("topic:b", 30, 100, 48), trend("topic:c", 30, 100, 48), trend("topic:d", 30, 100, 48)];
    const l = new Map([...["topic:a", "topic:b", "topic:c", "topic:d"].map((k) => [k, mentions(100)] as const), ["topic:new", mentions(9_000)] as const]);
    expect(pickRotation(b, ready, l, new Set(), rules, NOW)).toBeNull();
  });

  test("a trend that still draws more mentions than every waiting candidate stays", () => {
    const l = new Map(latest);
    l.set("topic:faded", mentions(9_000));
    expect(pickRotation(board(), ready, l, new Set(), rules, NOW)).toBeNull();
  });

  test("a pinned trend is never picked, under any listing version", () => {
    expect(pickRotation(board(), ready, latest, new Set(["topic:faded"]), rules, NOW)).toBeNull();
  });

  test("nothing rotates while a trend is cooling: its slot frees by itself", () => {
    const b = board().map((t) => (t.identifier === "topic:steady" ? { ...t, status: "Cooling" as const } : t));
    expect(pickRotation(b, ready, latest, new Set(), rules, NOW)).toBeNull();
  });

  test("of several that qualify, the weakest goes, against the strongest candidate", () => {
    const b = [...board().slice(0, 2), trend("topic:faded.2", 15, 50, 48), trend("topic:fading", 12, 40, 60), trend("topic:other", 25, 30, 60)];
    const l = new Map(latest);
    l.set("topic:fading", mentions(150));
    l.set("topic:loud", mentions(4_000));
    const pick = pickRotation(b, [candidate("topic:new"), candidate("topic:loud")], l, new Set(), { ...rules, maxLive: 5 }, NOW);
    expect(pick?.trend.identifier).toBe("topic:fading");
    expect(pick?.replacement.identifier).toBe("topic:loud");
  });
});
