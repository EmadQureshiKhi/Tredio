import { describe, expect, test } from "bun:test";
import { measure, type Readings } from "@tredio/oracle/src/method";
import { breakdown } from "../src/components";
import { NOW_SEC, trends } from "./helpers";

const at = NOW_SEC;
const r = (value: number, ageSec = 600) => ({ value, windowSec: 86_400, observedAt: at - ageSec });

/** Readings that exercise every rule: stale sources, Nansen for crypto, the Hacker News boost in and out. */
const CASES: Array<{ name: string; readings: Readings; crypto: boolean }> = [
  { name: "count sources only", readings: { elfa: r(1200), gdelt: r(40), wikipedia: r(20_000), bluesky: r(300) }, crypto: false },
  { name: "a stale GDELT reading drops out", readings: { gdelt: r(19, 3 * 86_400), wikipedia: r(145_122), bluesky: r(2901), hn: r(0) }, crypto: false },
  { name: "Hacker News boosts a quiet tech topic", readings: { bluesky: r(40), wikipedia: r(900), hn: r(250) }, crypto: false },
  { name: "Hacker News below the index stays out", readings: { elfa: r(5000), bluesky: r(2000), hn: r(3) }, crypto: false },
  { name: "Nansen shapes a crypto topic", readings: { elfa: r(800), bluesky: r(60), nansen: r(-350_000) }, crypto: true },
  { name: "Nansen alone counts for nothing", readings: { nansen: r(900_000) }, crypto: true },
  { name: "Nansen on a non-crypto topic is ignored", readings: { wikipedia: r(10_000), nansen: r(900_000) }, crypto: false },
  { name: "nothing at all", readings: {}, crypto: false },
];

describe("source components", () => {
  for (const c of CASES) {
    test(`${c.name}: the same index as the oracle's own measure()`, () => {
      const b = breakdown(c.readings, c.crypto, at);
      const m = measure(c.readings, c.crypto, at);
      expect(b.points).toBe(m.points);
      // The sources that counted are the oracle's, and their points add up to the index.
      expect(b.sources.filter((s) => s.counted).map((s) => s.source).sort()).toEqual([...m.sources].sort());
      if (b.points !== null) {
        const sum = b.sources.reduce((a, s) => a + s.points, 0);
        expect(Math.abs(sum - b.points)).toBeLessThan(0.03);
        const shares = b.sources.reduce((a, s) => a + s.share, 0);
        expect(Math.abs(shares - 1)).toBeLessThan(0.002);
      }
      expect(b.sources.map((s) => s.source)).toEqual(["elfa", "gdelt", "wikipedia", "bluesky", "nansen", "hn"]);
      for (const s of b.sources) {
        if (!s.counted) {
          expect(s.reason).not.toBeNull();
          expect(s.points).toBe(0);
          expect(s.weight).toBe(0);
        }
      }
    });
  }

  test("each source says why it did not count", () => {
    const b = breakdown({ gdelt: r(19, 3 * 86_400), bluesky: r(2901), hn: r(0), nansen: r(10) }, false, at);
    const why = Object.fromEntries(b.sources.map((s) => [s.source, s.reason]));
    expect(why).toEqual({
      elfa: "no reading for this topic",
      gdelt: "reading older than 2 h",
      wikipedia: "no reading for this topic",
      bluesky: null,
      nansen: "counts for crypto topics only",
      hn: "a boost: below the index, so left out",
    });
    expect(breakdown({ nansen: r(10) }, true, at).sources.find((s) => s.source === "nansen")!.reason).toBe("counts only beside an attention source");
  });

  test("every live trend's readings, recomputed at capture time, agree with the oracle's method", () => {
    for (const t of trends) {
      const crypto = t.assetClass === "crypto";
      expect(breakdown(t.readings as Readings, crypto, at).points).toBe(measure(t.readings as Readings, crypto, at).points);
    }
  });
});
