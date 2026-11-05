import { describe, expect, test } from "bun:test";
import { rankQueue, READING_MAX_AGE_SEC, usable } from "../src/queue";
import type { Candidate, Reading, SourceName } from "../src/store";

const NOW = 1_791_720_000;
const candidate = (identifier: string, assetClass = 6, ticker: string | null = null): Candidate => ({
  id: 1,
  identifier,
  displayName: identifier,
  assetClass,
  keywords: [],
  article: null,
  ticker,
  summary: null,
  source: "elfa_trending",
  sourceRef: {},
  surfacer: "radar",
  status: "approved",
  confidence: 0.9,
  ai: {},
  decidedBy: "radar",
  reviewHash: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const at = (value: number, ageSec: number): Reading => ({ value, windowSec: 86_400, observedAt: NOW - ageSec });
const opts = { nowSec: NOW, confirmNetflowUsd: 100_000, tradable: new Set(["BTC"]) };

describe("oracle queue", () => {
  test("offers only candidates with a reading the oracle still accepts", () => {
    const latest = new Map<string, Partial<Record<SourceName, Reading>>>([
      // Only an Elfa count from 13 hours ago: the oracle would measure nothing.
      ["equity:stale", { elfa: at(70, 46_800) }],
      // A day-old Wikipedia count is still within its two days.
      ["topic:wiki", { elfa: at(5, 46_800), wikipedia: at(90_000, 86_400) }],
      ["topic:loud", { elfa: at(900, 600) }],
      // Fresh, but zero everywhere: an index of 0 never lists.
      ["topic:silent", { elfa: at(0, 600), wikipedia: at(0, 600) }],
      // Smart money confirmed, but only by an expired reading.
      ["crypto:old-flow", { elfa: at(800, 600), nansen: at(500_000, 50_000) }],
      ["crypto:eth", { elfa: at(3_000, 600), nansen: at(1_200_000, 600) }],
      ["crypto:btc", { elfa: at(10, 600), nansen: at(150_000, 600) }],
      ["crypto:near", { elfa: at(5_000, 600), nansen: at(20_000, 600) }],
    ]);
    const approved = [...latest.keys(), "topic:unmeasured"].map((id) => candidate(id, id.startsWith("crypto:") ? 0 : 6, id.startsWith("crypto:") ? id.slice(7).toUpperCase() : null));
    // assets with asset perps first, then the most-mentioned.
    expect(rankQueue(approved, latest, opts).map((c) => c.identifier)).toEqual(["crypto:btc", "crypto:eth", "topic:loud", "topic:wiki"]);
  });

  test("a kept (pinned) topic goes first, and a pinned crypto one needs no smart-money inflow", () => {
    const latest = new Map<string, Partial<Record<SourceName, Reading>>>([
      ["crypto:btc", { elfa: at(10, 600), nansen: at(150_000, 600) }],
      // Smart money is selling both.
      ["crypto:eth", { elfa: at(3_000, 600), nansen: at(-281_000, 600) }],
      ["crypto:sol", { elfa: at(9_000, 600), nansen: at(-281_000, 600) }],
      ["topic:loud", { elfa: at(900, 600) }],
      // A pin never makes an unmeasured topic listable.
      ["topic:kept-silent", { elfa: at(0, 600) }],
    ]);
    const approved = [...latest.keys()].map((id) => candidate(id, id.startsWith("crypto:") ? 0 : 6, id.startsWith("crypto:") ? id.slice(7).toUpperCase() : null));
    const pinned = new Set(["crypto:eth", "topic:kept-silent"]);
    expect(rankQueue(approved, latest, { ...opts, pinned }).map((c) => c.identifier)).toEqual(["crypto:eth", "crypto:btc", "topic:loud"]);
    expect(rankQueue(approved, latest, opts).map((c) => c.identifier)).toEqual(["crypto:btc", "topic:loud"]);
  });

  test("Bluesky measures a candidate, and ranks it while Elfa is silent; Hacker News alone does not", () => {
    const latest = new Map<string, Partial<Record<SourceName, Reading>>>([
      ["topic:bsky-small", { bluesky: at(20, 600) }],
      ["topic:bsky-big", { bluesky: at(400, 600) }],
      // 3,000 X mentions rank between 400 and 20 Bluesky posts (a tenth of X's volume).
      ["topic:x", { elfa: at(3_000, 600) }],
      ["topic:hn-only", { hn: at(80, 600) }],
    ]);
    const approved = [...latest.keys()].map((id) => candidate(id));
    expect(rankQueue(approved, latest, opts).map((c) => c.identifier)).toEqual(["topic:bsky-big", "topic:x", "topic:bsky-small"]);
  });

  test("a reading is usable up to its source's age limit, inclusive", () => {
    expect(usable(at(5, READING_MAX_AGE_SEC.gdelt), "gdelt", NOW)).toBe(5);
    expect(usable(at(5, READING_MAX_AGE_SEC.gdelt + 1), "gdelt", NOW)).toBeNull();
    expect(usable(undefined, "elfa", NOW)).toBeNull();
  });
});
