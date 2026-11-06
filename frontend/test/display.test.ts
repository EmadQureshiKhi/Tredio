import { describe, expect, test } from "bun:test";
import type { Time } from "lightweight-charts";
import { extendsSeries, fitRange, withAlpha } from "../src/components/ui/Chart";
import { liveDefault, readableWarning } from "../src/features/autopilot/builder/rule-form";
import { faucetButton, faucetState, isCooldown, untilText } from "../src/features/global/faucet-claims";
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

describe("faucet", () => {
  const now = 1_000_000_000_000;
  test("the API's next draw time counts down, and a passed one is ready", () => {
    expect(faucetState(null, now)).toEqual({ kind: "ready" });
    expect(faucetState(now / 1000 + 3600, now)).toEqual({ kind: "waiting", nextAt: now + 3_600_000 });
    expect(faucetState(now / 1000 - 1, now)).toEqual({ kind: "ready" });
  });

  test("the button says what happened and what comes next", () => {
    expect(faucetButton({ kind: "ready" }, now, null)).toEqual({ label: "Get test USDC", tone: "ready" });
    expect(faucetButton({ kind: "ready" }, now, "1,000.00")).toEqual({ label: "Claimed 1,000.00 USDC", tone: "success" });
    expect(faucetButton({ kind: "waiting", nextAt: now + 45 * 60_000 }, now, null)).toEqual({ label: "Claimed, next in 45m", tone: "waiting" });
  });

  test("only the contract's cooldown refusal counts as already claimed", () => {
    expect(isCooldown("faucet cooldown")).toBe(true);
    expect(isCooldown("This account drew test USDC a short while ago. The faucet pays once per cooldown.")).toBe(true);
    expect(isCooldown("the faucet is testnet only")).toBe(false);
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
