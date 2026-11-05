import { describe, expect, test } from "bun:test";
import type { Time } from "lightweight-charts";
import { extendsSeries, fitRange, withAlpha } from "../src/components/ui/Chart";
import { liveDefault, readableWarning } from "../src/features/autopilot/builder/rule-form";
import { CLAIM_EVERY_MS, faucetState, isAlreadyClaimed, RETRY_AFTER_REFUSAL_MS, untilText } from "../src/features/global/faucet-claims";
import { tokens } from "../src/features/portfolio/format";
import type { Trend } from "../src/lib/api";
import { tokenAmount } from "../src/lib/format";

describe("token amounts", () => {
  test("cut, never rounded up, so a holding never shows more than it is", () => {
    expect(tokenAmount(1_875_000n, 6)).toBe("1.87");
    expect(tokenAmount(1_879_999n, 6)).toBe("1.87");
    expect(tokenAmount(0n, 6)).toBe("0.00");
    expect(tokenAmount(2_000_000n, 6)).toBe("2.00");
    expect(tokenAmount(1_234_567_890_000n, 6)).toBe("1,234,567.89");
    expect(tokenAmount(1_500_000_000_000_000_000n, 18)).toBe("1.50");
    expect(tokenAmount(1_870_001n, 6, 6)).toBe("1.870001");
    expect(tokenAmount(-1_875_000n, 6)).toBe("-1.87");
    expect(tokenAmount(-1n, 6)).toBe("0.00");
  });

  test("the portfolio and the ticket format a holding alike", () => {
    expect(tokens(1_875_000n)).toBe(tokenAmount(1_875_000n, 6));
    expect(tokens(10n ** 18n + 5n * 10n ** 15n, 18)).toBe("1.00");
  });
});

describe("faucet claims", () => {
  const now = 1_000_000_000_000;
  test("a claim made here counts down to the next one", () => {
    expect(faucetState(null, now)).toEqual({ kind: "ready" });
    expect(faucetState({ at: now - 3_600_000, known: true }, now)).toEqual({ kind: "claimed", nextAt: now - 3_600_000 + CLAIM_EVERY_MS });
    expect(faucetState({ at: now - CLAIM_EVERY_MS - 1, known: true }, now)).toEqual({ kind: "ready" });
  });

  test("a refusal (claimed elsewhere) waits an hour before offering a retry", () => {
    expect(faucetState({ at: now, known: false }, now)).toEqual({ kind: "refused", retryAt: now + RETRY_AFTER_REFUSAL_MS });
    expect(faucetState({ at: now - RETRY_AFTER_REFUSAL_MS, known: false }, now)).toEqual({ kind: "ready" });
  });

  test("only the faucet's already-claimed refusal counts as a claim", () => {
    expect(isAlreadyClaimed(429, "This account already received test USDC today.")).toBe(true);
    expect(isAlreadyClaimed(429, "The faucet has paid out today's test USDC. Try again tomorrow.")).toBe(false);
    expect(isAlreadyClaimed(503, "This account already received test USDC today.")).toBe(false);
  });

  test("the wait reads in hours and minutes", () => {
    expect(untilText(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
    expect(untilText(45 * 60_000 - 1)).toBe("45m");
    expect(untilText(10_000)).toBe("1m");
  });
});

describe("chart", () => {
  const rows = (...ts: number[]) => ts.map((t) => ({ time: t as Time }));
  test("a new or revised last reading updates in place; another history replaces the data", () => {
    expect(extendsSeries(rows(1, 2, 3), rows(1, 2, 3))).toBe(true);
    expect(extendsSeries(rows(1, 2, 3), rows(1, 2, 3, 4))).toBe(true);
    expect(extendsSeries(rows(1, 2, 3), rows(2, 3, 4))).toBe(false);
    expect(extendsSeries(rows(1, 2, 3), rows(1, 2))).toBe(false);
    expect(extendsSeries([], rows(1))).toBe(false);
  });

  test("a flat line gets a minimum range around it, and the reference stays in view", () => {
    expect(fitRange(68.6, 68.6, 4)).toEqual({ minValue: 66.6, maxValue: 70.6 });
    expect(fitRange(60, 70, 4)).toEqual({ minValue: 60, maxValue: 70 });
    expect(fitRange(60, 62, 1, 80)).toEqual({ minValue: 60, maxValue: 80 });
  });

  test("token colors take an opacity the canvas understands", () => {
    expect(withAlpha("#34d399", 0.2)).toBe("#34d39933");
    expect(withAlpha("#fafafa66", 0.5)).toBe("#fafafa33");
    expect(withAlpha("#fafafa66", 0)).toBe("#fafafa00");
    expect(withAlpha("#fff", 1)).toBe("#ffffffff");
    expect(withAlpha("rgba(250, 250, 250, 0.62)", 0.5)).toBe("rgba(250, 250, 250, 0.31)");
    expect(withAlpha("rgb(1,2,3)", 0)).toBe("rgba(1, 2, 3, 0)");
  });
});

describe("rule builder", () => {
  const trend = (identifier: string, index: number, ticker: string | null, status: Trend["status"] = "active") => ({ identifier, index, ticker, status, createdAt: index }) as Trend;

  test("a new rule starts on the hottest live trend with an asset perp, trading its coin", () => {
    const list = [trend("crypto:eth", 40, "ETH", "retired"), trend("person:x", 90, null), trend("crypto:btc", 70, "BTC"), trend("crypto:sol", 60, "SOL")];
    expect(liveDefault(list, ["BTC", "SOL", "ETH"])).toEqual({ trend: "crypto:btc", market: "BTC" });
  });

  test("without a listed coin it takes the hottest trend, and nothing live keeps the defaults", () => {
    expect(liveDefault([trend("person:x", 90, null)], ["ETH"])).toEqual({ trend: "person:x" });
    expect(liveDefault([trend("person:x", 90, null)], ["BTC"])).toEqual({ trend: "person:x", market: "BTC" });
    expect(liveDefault([], ["ETH"])).toEqual({});
  });

  test("backtest caveats read as sentences with local dates", () => {
    const w = readableWarning("attention history starts 2026-10-09T19:08:00.000Z; earlier candles cannot trigger");
    expect(w).not.toContain("T19:08");
    expect(w.startsWith("Attention history starts ")).toBe(true);
    expect(w).toContain(new Date("2026-10-09T19:08:00.000Z").toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  });
});
