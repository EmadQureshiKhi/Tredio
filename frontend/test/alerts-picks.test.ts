import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeAlert } from "../src/features/alerts/useAlerts";
import { heatingOrder, wantedOrder } from "../src/features/radar/RadarCard";
import type { Candidate } from "../src/lib/api";
import { storedTopics } from "../src/lib/push";

describe("attention alerts in plain words", () => {
  test("moves name the percentage and window, crossings the level", () => {
    expect(describeAlert({ kind: "rise", changePct: 20, windowMin: 60, level: null })).toBe("Rises 20% within 1 hour");
    expect(describeAlert({ kind: "drop", changePct: 10, windowMin: 15, level: null })).toBe("Drops 10% within 15 min");
    expect(describeAlert({ kind: "rise", changePct: 50, windowMin: 1440, level: null })).toBe("Rises 50% within 1 day");
    expect(describeAlert({ kind: "above", changePct: null, windowMin: null, level: 80 })).toBe("Rises above 80");
    expect(describeAlert({ kind: "below", changePct: null, windowMin: null, level: 30 })).toBe("Falls below 30");
  });
});

describe("community picks on the radar", () => {
  const c = (id: number, over: Partial<Candidate>): Candidate =>
    ({ id, identifier: `topic:t${id}`, displayName: `T${id}`, summary: null, assetClass: "topic", keywords: [], source: "radar", surfacer: "radar", status: "approved", createdAt: "2026-10-20T00:00:00Z", ...over }) as Candidate;

  test("picks lead the heating order, and most wanted sorts by accounts waiting", () => {
    const hot = c(1, { heating: 400, queue: 9 });
    const pick = c(2, { heating: 10, queue: 1, pick: true, watchers: 4 });
    const wanted = c(3, { heating: 50, queue: 20, watchers: 9 });
    expect([hot, wanted, pick].sort(heatingOrder).map((x) => x.id)).toEqual([2, 1, 3]);
    expect([hot, pick, wanted].sort(wantedOrder).map((x) => x.id)).toEqual([3, 2, 1]);
  });
});

describe("push topics added later", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test("a device's earlier topic list gains attention alerts once, and a later choice to drop them holds", () => {
    store.set("tredio.push.topics", JSON.stringify(["autopilot", "markets"]));
    expect(storedTopics()).toEqual(["autopilot", "markets", "alerts"]);
    store.set("tredio.push.topics", JSON.stringify(["markets"]));
    expect(storedTopics()).toEqual(["markets"]);
  });
});
