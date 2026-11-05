import { describe, expect, test } from "bun:test";
import { findArbitrage, ladders, pickSeries, requoteUrgency } from "../src/strategy";

const q = { halfSpread: 0.03, levelStep: 0.01, levels: 2, levelTokens: 20, maxSkew: 0.03, inventoryLimit: 60 };

describe("ladders", () => {
  test("quote both sides around fair value, never offering a set below or above 1", () => {
    const { up, down } = ladders(0.6, { up: 100, down: 100, usdc: 1000 }, q);
    expect(up.bids.map((l) => l.tick)).toEqual([570, 560]);
    expect(up.asks.map((l) => l.tick)).toEqual([630, 640]);
    expect(down.bids.map((l) => l.tick)).toEqual([370, 360]);
    expect(up.asks[0]!.tick + down.asks[0]!.tick).toBeGreaterThan(1000);
    expect(up.bids[0]!.tick + down.bids[0]!.tick).toBeLessThan(1000);
    expect(up.bids[0]!.size).toBe(20_000_000n);
  });

  test("skew against inventory and stop adding to a full side", () => {
    const long = ladders(0.5, { up: 120, down: 20, usdc: 1000 }, q);
    expect(long.up.bids).toHaveLength(0);
    expect(long.up.asks[0]!.tick).toBe(500);
    // No tokens, no asks; no USDC, no bids.
    const empty = ladders(0.5, { up: 0, down: 0, usdc: 0 }, q);
    expect(empty.up.asks).toHaveLength(0);
    expect(empty.up.bids).toHaveLength(0);
  });
});

test("re-quote urgency", () => {
  const want = { bids: [{ tick: 570, size: 20_000_000n }], asks: [{ tick: 630, size: 20_000_000n }] };
  expect(requoteUrgency(want, want, 20)).toBe("none");
  expect(requoteUrgency({ ...want, bids: [{ tick: 549, size: 20_000_000n }] }, want, 20)).toBe("drift");
  expect(requoteUrgency({ ...want, bids: [{ tick: 520, size: 20_000_000n }] }, want, 20)).toBe("urgent");
  expect(requoteUrgency({ ...want, bids: [{ tick: 570, size: 5_000_000n }] }, want, 20)).toBe("urgent");
  expect(requoteUrgency({ ...want, bids: [] }, want, 20)).toBe("urgent");
});

test("series order and arbitrage", () => {
  expect(pickSeries([{ window: 604_800, index: 90 }, { window: 86_400, index: 10 }, { window: 86_400, index: 50 }], 2)).toEqual([{ window: 86_400, index: 50 }, { window: 86_400, index: 10 }]);
  const lvl = (tick: number) => ({ tick, size: 10_000_000n });
  expect(findArbitrage({ bestBid: null, bestAsk: lvl(450) }, { bestBid: null, bestAsk: lvl(500) }, 20, 0.005, 100)).toMatchObject({ kind: "buyBoth", tokens: 10 });
  expect(findArbitrage({ bestBid: lvl(560), bestAsk: null }, { bestBid: lvl(470), bestAsk: null }, 20, 0.005, 100)).toMatchObject({ kind: "sellBoth" });
  expect(findArbitrage({ bestBid: lvl(500), bestAsk: lvl(520) }, { bestBid: lvl(480), bestAsk: lvl(500) }, 20, 0.005, 100)).toBeNull();
});
