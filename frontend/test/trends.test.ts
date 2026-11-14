import { describe, expect, test } from "bun:test";
import { atCap, INDEX_CAP, SOURCE_MAX_AGE_SEC, staleReading } from "../src/lib/trends";

describe("the index cap", () => {
  test("a trend reads the cap at 100 points and not below", () => {
    expect(INDEX_CAP).toBe(100);
    expect(atCap(100)).toBe(true);
    expect(atCap(100.0)).toBe(true);
    expect(atCap(99.99)).toBe(false);
    expect(atCap(0)).toBe(false);
  });
});

describe("stale readings", () => {
  const now = 1_800_000_000;

  test("a reading is stale once it is older than its source's window", () => {
    expect(staleReading("elfa", { observedAt: now - SOURCE_MAX_AGE_SEC.elfa }, now)).toBe(false);
    expect(staleReading("elfa", { observedAt: now - SOURCE_MAX_AGE_SEC.elfa - 1 }, now)).toBe(true);
    expect(staleReading("gdelt", { observedAt: now - 6 * 86_400 }, now)).toBe(true);
    expect(staleReading("wikipedia", { observedAt: now - 86_400 }, now)).toBe(false);
  });

  test("a source that never answered is not stale, it is unmeasured", () => {
    expect(staleReading("hn", null, now)).toBe(false);
  });

  test("the windows mirror the enclave's maxAgeSec per source", () => {
    expect(SOURCE_MAX_AGE_SEC).toEqual({ elfa: 43_200, bluesky: 7_200, gdelt: 7_200, wikipedia: 172_800, hn: 10_800, nansen: 43_200 });
  });
});
