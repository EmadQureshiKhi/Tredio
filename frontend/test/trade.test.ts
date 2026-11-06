import { describe, expect, test } from "bun:test";
import { base64Decode } from "../src/lib/chain/encoding";
import { limitBuyFunds, ownerCall, owner, session, walletCalls } from "../src/lib/trade/calls";
import { type BookSide, anchoredLimit, cost, minimumOut, perpPreview, quoteBuy, quoteSell } from "../src/lib/trade/math";
import { DEPLOYMENT } from "../src/lib/config";

const book: BookSide = {
  // Asks: 2 tokens at 0.400, 3 at 0.450. Bids: 1 at 0.380, 5 at 0.350 (raw 6 decimals).
  asks: [
    { tick: 400, size: 2_000_000n },
    { tick: 450, size: 3_000_000n },
  ],
  bids: [
    { tick: 380, size: 1_000_000n },
    { tick: 350, size: 5_000_000n },
  ],
};
const FEE = 20n;

describe("order book quotes, as the book fills them", () => {
  test("a buy walks the asks with the taker fee on top and never spends more than the budget", () => {
    // 1 USDC: 2 tokens at 0.400 cost 0.8 + 0.0016 fee; the rest buys lots at 0.450.
    const q = quoteBuy(book, 1_000_000n, FEE);
    expect(q.filled).toBeLessThanOrEqual(1_000_000n);
    const atFirst = cost(2_000_000n, 400);
    const restLots = ((1_000_000n - atFirst - (atFirst * FEE) / 10_000n) * 10_000n) / (450n * 10_020n);
    expect(q.out).toBe(2_000_000n + restLots * 1000n);
    expect(q.worstTick).toBe(450);
    expect(q.complete).toBe(true);
  });

  test("a buy stops at its limit tick and says the book did not take all of it", () => {
    const q = quoteBuy(book, 5_000_000n, FEE, 400);
    expect(q.out).toBe(2_000_000n);
    expect(q.worstTick).toBe(400);
    expect(q.complete).toBe(false);
  });

  test("a sell fills the bids best first, in whole lots, and pays the fee out of the proceeds", () => {
    const q = quoteSell(book, 2_500_500n, FEE);
    // 2.5005 tokens sell as 2.500 (whole lots): 1 at 0.380 and 1.5 at 0.350.
    expect(q.filled).toBe(2_500_000n);
    const gross = cost(1_000_000n, 380) + cost(1_500_000n, 350);
    expect(q.out).toBe(gross - (gross * FEE) / 10_000n);
    expect(q.complete).toBe(true);
  });

  test("minimum out is the quote less the slippage", () => {
    expect(minimumOut(1_000_000n, 100)).toBe(990_000n);
  });

  test("the anchored band matches the book contract's anchored_limit", () => {
    // fair 0.42: buys up to 0.520, sells down to 0.320.
    expect(anchoredLimit(true, 0.42)).toBe(520);
    expect(anchoredLimit(false, 0.42)).toBe(320);
    // Clamped to the tick range at the edges.
    expect(anchoredLimit(true, 0.95)).toBe(999);
    expect(anchoredLimit(false, 0.05)).toBe(1);
    // Sells round up to the next tick, like div_ceil.
    expect(anchoredLimit(false, 0.4205)).toBe(321);
  });

  test("a limit buy moves its cost and the most fee it could pay into the book", () => {
    // 3 tokens at 0.500 = 1.5 USDC, fee 0.2% rounded up.
    expect(limitBuyFunds(3_000_000n, 500)).toBe(1_500_000n + 3_000n);
  });
});

describe("attention perps, as the perps contract opens them", () => {
  test("100 USDC at 3x on an index of 50 matches the contract's own test", () => {
    const p = perpPreview({ margin: 100_000_000n, leverage: 3, index: 50, isLong: true, longQty: 0n, shortQty: 0n })!;
    expect(p.net).toBe(99_700_897n);
    expect(p.fee).toBe(100_000_000n - 99_700_897n);
    expect((p.qty * 50_000_000n) / 10n ** 18n).toBe(299_102_691n);
    // A long is liquidated below the entry, a short above it.
    expect(p.liquidationIndex).not.toBeNull();
    expect(p.liquidationIndex!).toBeLessThan(50);
    const short = perpPreview({ margin: 100_000_000n, leverage: 3, index: 50, isLong: false, longQty: 0n, shortQty: 0n })!;
    expect(short.liquidationIndex!).toBeGreaterThan(50);
  });

  test("more than 3x or no margin is no preview", () => {
    expect(perpPreview({ margin: 100_000_000n, leverage: 4, index: 50, isLong: true, longQty: 0n, shortQty: 0n })).toBeNull();
    expect(perpPreview({ margin: 0n, leverage: 2, index: 50, isLong: true, longQty: 0n, shortQty: 0n })).toBeNull();
  });

  test("the crowded side pays funding and the other side earns it", () => {
    const longs = perpPreview({ margin: 10_000_000n, leverage: 2, index: 40, isLong: true, longQty: 10n ** 20n, shortQty: 0n })!;
    expect(longs.fundingPerHourPct).toBeGreaterThan(0);
    const shorts = perpPreview({ margin: 10_000_000n, leverage: 2, index: 40, isLong: false, longQty: 10n ** 20n, shortQty: 0n })!;
    expect(shorts.fundingPerHourPct).toBeLessThan(0);
  });
});

describe("what the app sends", () => {
  const c = DEPLOYMENT.contracts;

  test("a session swap has the shape the account contract's session_call takes", () => {
    expect(session.swap(4, "up", true, 1_000_000n, 990n)).toEqual({ swap: { series: 4, side: "up", buy: true, amount: "1000000", min_out: "990" } });
    expect(session.perpOpen("topic:x", true, 5_000_000n, 20_000, 51_000_000)).toEqual({ perp_open: { trend: "topic:x", is_long: true, margin: "5000000", leverage_bps: 20_000, acceptable_index: 51_000_000 } });
  });

  test("an owner call carries the contract call with its arguments as base64 JSON", () => {
    const call = owner.cancelOrder(12);
    const action = ownerCall(call) as { call: { receiver_id: string; method_name: string; args: string; deposit: string; gas: string } };
    expect(action.call.receiver_id).toBe(c.book);
    expect(action.call.method_name).toBe(call.methodName);
    expect(JSON.parse(new TextDecoder().decode(base64Decode(action.call.args)))).toEqual(call.args);
  });

  test("a wallet's swap is a transfer to the book with an anchored swap message", () => {
    const [buy] = walletCalls(session.swap(4, "down", true, 2_000_000n, 1_900_000n));
    expect(buy!.receiverId).toBe(c.usdc);
    expect(buy!.methodName).toBe("ft_transfer_call");
    const args = buy!.args as { receiver_id: string; amount: string; msg: string };
    expect(args.receiver_id).toBe(c.book);
    expect(args.amount).toBe("2000000");
    expect(JSON.parse(args.msg)).toEqual({ swap: { series: 4, side: "down", limit_tick: null, min_out: "1900000", anchored: true } });
    const [sell] = walletCalls(session.swap(4, "up", false, 1_000_000n, 300_000n));
    expect(sell!.receiverId).toBe(c.outcomes);
  });

  test("a wallet cannot place Hyperliquid orders", () => {
    expect(() => walletCalls(session.hlLeverage(0, true, 3, 1))).toThrow(/passkey account/);
  });
});
