import { describe, expect, test } from "bun:test";
import { orderOutcome } from "@tredio/hyperliquid";
import { buildOrder, classify, guardProblem, isBuy, openingLeverage, sizeAtLeverage, toE8, worstPrice } from "../src/orders";

const BTC = { symbol: "BTC", index: 3, szDecimals: 5 };
const SOL = { symbol: "SOL", index: 0, szDecimals: 2 };

describe("worst price", () => {
  test("is the slippage from the mark against the order, or a tighter bound", () => {
    expect(worstPrice(true, 100, 50)).toBeCloseTo(100.5);
    expect(worstPrice(false, 100, 50)).toBeCloseTo(99.5);
    expect(worstPrice(true, 100, 50, 100.2)).toBeCloseTo(100.2);
    expect(worstPrice(true, 100, 50, 101)).toBeCloseTo(100.5);
    expect(worstPrice(false, 100, 50, 99.8)).toBeCloseTo(99.8);
  });

  test("openings trade the position's side; closes and reductions the other way", () => {
    expect(isBuy("open", "long")).toBe(true);
    expect(isBuy("open", "short")).toBe(false);
    expect(isBuy("close", "long")).toBe(false);
    expect(isBuy("reduce", "short")).toBe(true);
  });
});

describe("orders", () => {
  test("an immediate-or-cancel limit, the price rounded toward the mark and the size down to the lot", () => {
    // 76,439 + 0.5% = 76,821.195: five significant figures, so whole dollars; a buy rounds down.
    expect(buildOrder(BTC, { buy: true, worstPrice: 76_821.195, size: 0.000144, reduceOnly: false })).toEqual({
      asset: "BTC",
      asset_index: 3,
      is_buy: true,
      price: "76821",
      size: "0.00014",
      reduce_only: false,
      tif: "Ioc",
    });
    // A sell rounds up: never below the worst price, never further from the mark.
    const sell = buildOrder(SOL, { buy: false, worstPrice: 90.09624, size: 1.239, reduceOnly: true });
    expect(sell).toMatchObject({ is_buy: false, price: "90.097", size: "1.23", reduce_only: true });
  });

  test("a size below one lot is skipped, not sent as zero", () => {
    expect(buildOrder(BTC, { buy: true, worstPrice: 76_000, size: 0.000004, reduceOnly: false })).toEqual({ skip: "0.000004 BTC is below one lot (0.00001)" });
    expect(buildOrder(BTC, { buy: true, worstPrice: 0, size: 1, reduceOnly: false })).toEqual({ skip: "no price" });
  });

  test("rebuilding from the recorded price and size gives the same order (a resend is the same action)", () => {
    const first = buildOrder(BTC, { buy: false, worstPrice: 75_234.77, size: 0.00052, reduceOnly: true });
    if ("skip" in first) throw new Error(first.skip);
    expect(buildOrder(BTC, { buy: false, worstPrice: Number(first.price), size: Number(first.size), reduceOnly: true })).toEqual(first);
  });
});

describe("the account's order guard", () => {
  const mark = { price: "7630500000000", at: 1_000 };
  test("reads prices as the contract does, with 8 decimals", () => {
    expect(toE8("76305")).toBe(7_630_500_000_000n);
    expect(toE8("0.00012345")).toBe(12_345n);
    expect(toE8("1.5")).toBe(150_000_000n);
    expect(toE8("1e5")).toBeNull();
  });

  const v1 = { assetIndex: 3, version: 1 };
  const v2 = { assetIndex: 3, version: 2 };

  test("accepts a price within 2% of a fresh mark", () => {
    expect(guardProblem("BTC", "77831", mark, 1_050, v1)).toBeNull();
    expect(guardProblem("BTC", "74779", mark, 1_050, v1)).toBeNull();
  });

  test("refuses beyond 2%, a mark about to age out, or no mark at all", () => {
    expect(guardProblem("BTC", "77832", mark, 1_050, v1)).toContain("more than 2%");
    expect(guardProblem("BTC", "76305", mark, 1_101, v1)).toBe("Tredio's BTC mark is 101s old; orders wait for the oracle's next one");
    expect(guardProblem("BTC", "76305", mark, 1_100, v1)).toBeNull();
    expect(guardProblem("DOGE", "0.2", null, 1_050, v1)).toContain("no DOGE mark");
  });

  test("v2 accounts accept a mark up to five minutes old, less the margin for the order to land", () => {
    const indexed = { ...mark, asset_index: 3 };
    expect(guardProblem("BTC", "76305", indexed, 1_280, v2)).toBeNull();
    expect(guardProblem("BTC", "76305", indexed, 1_281, v2)).toBe("Tredio's BTC mark is 281s old; orders wait for the oracle's next one");
  });

  test("v2 accounts need the mark to name the asset index the order signs; v1 accounts do not check it", () => {
    expect(guardProblem("BTC", "76305", { ...mark, asset_index: 3 }, 1_050, v2)).toBeNull();
    expect(guardProblem("BTC", "76305", { ...mark, asset_index: 0 }, 1_050, v2)).toBe("Tredio's BTC mark is for Hyperliquid asset 0, not the order's 3");
    // The deployed registry returns no index at all, a new one null until the oracle reports it: v2 refuses both.
    expect(guardProblem("BTC", "76305", mark, 1_050, v2)).toContain("does not name its Hyperliquid asset yet");
    expect(guardProblem("BTC", "76305", { ...mark, asset_index: null }, 1_050, v2)).toContain("does not name its Hyperliquid asset yet");
    expect(guardProblem("BTC", "76305", { ...mark, asset_index: 0 }, 1_050, v1)).toBeNull();
    expect(guardProblem("BTC", "76305", mark, 1_050, v1)).toBeNull();
  });
});

describe("leverage", () => {
  test("a whole number within the market's and the session's caps", () => {
    expect(openingLeverage(2.5, 40, 10)).toBe(2);
    expect(openingLeverage(15, 40, 10)).toBe(10);
    expect(openingLeverage(8, 5, 10)).toBe(5);
    expect(openingLeverage(0.5, 40, 10)).toBe(1);
  });

  test("a lower leverage keeps the margin and shrinks the size", () => {
    expect(sizeAtLeverage(1, 2.5, 2)).toBeCloseTo(0.8);
    expect(sizeAtLeverage(1, 2, 2)).toBe(1);
  });
});

describe("Hyperliquid's answers", () => {
  test("filled, not matched, refused, or a nonce it has seen", () => {
    expect(classify({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.00014", avgPx: "76450.0", oid: 77 } }] } } })).toEqual({ status: "filled", size: 0.00014, price: 76_450, oid: 77 });
    expect(classify({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order could not immediately match against any resting orders. asset=3" }] } } }).status).toBe("unfilled");
    expect(classify({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin to place order. asset=3" }] } } })).toEqual({ status: "failed", error: "Insufficient margin to place order. asset=3" });
    expect(classify({ status: "err", response: "Invalid nonce: duplicate nonce 1793911905000" }).status).toBe("seen");
    expect(classify({ status: "err", response: "User or API Wallet 0xabc does not exist." }).status).toBe("failed");
  });

  test("agrees with the package's own reading of an answer", () => {
    const r = { status: "ok" as const, response: { type: "order", data: { statuses: [{ resting: { oid: 5 } }] } } };
    expect(orderOutcome(r)).toEqual({ ok: true, oid: 5, filled: null });
    expect(classify(r)).toEqual({ status: "unfilled", error: "the order rested instead of filling" });
  });
});
