import { describe, expect, test } from "bun:test";
import {
  backtest,
  type Candle,
  copyLimit,
  diffHolding,
  evaluate,
  followSettingsSchema,
  mirror,
  openPnl,
  type Rule,
  ruleSchema,
  type RuleState,
  sessionLeverageProblem,
  stats,
  withFollowDefaults,
} from "../src";

const rule: Rule = ruleSchema.parse({
  name: "BTC attention breakout",
  market: "BTC",
  trend: "crypto:btc",
  entry: { attentionChangePct: 30, windowMin: 60, side: "long", smartMoney: "buying" },
  size: { marginUsdc: 50, leverage: 2 },
  exits: { stopLossPct: 5, takeProfitPct: 10 },
  limits: { maxPositionUsdc: 200, maxDailyLossUsdc: 20, cooldownMin: 30 },
});
const flat: RuleState = { position: null, realizedTodayUsdc: 0, lastExitAt: null, killed: false };
const T = 1_800_000_000;
// Index 40 an hour ago, 55 now: +37.5%.
const rising = [
  { t: T - 7200, v: 40 },
  { t: T - 3600, v: 40 },
  { t: T - 60, v: 55 },
];

describe("rules", () => {
  test("validates stops against liquidation and sizes against the cap", () => {
    const bad = ruleSchema.safeParse({ ...rule, size: { marginUsdc: 150, leverage: 10 }, exits: { stopLossPct: 12, takeProfitPct: 10 } });
    expect(bad.success).toBe(false);
    const messages = bad.error!.issues.map((i) => i.message).join(" | ");
    expect(messages).toContain("beyond liquidation");
    expect(messages).toContain("above the maximum position");
    expect(ruleSchema.safeParse({ ...rule, entry: { ...rule.entry, attentionChangePct: 0 } }).success).toBe(false);
  });
});

describe("session leverage", () => {
  test("an account's rule opens at no more than its session's cap; the bot's rules are not checked", () => {
    expect(sessionLeverageProblem({ size: { marginUsdc: 10, leverage: 10 } }, 10)).toBeNull();
    expect(sessionLeverageProblem({ size: { marginUsdc: 10, leverage: 10.5 } }, 10)).toBe("Autopilot opens positions from your account at up to 10x; lower the leverage");
    expect(ruleSchema.safeParse({ ...rule, size: { marginUsdc: 5, leverage: 20 }, exits: { stopLossPct: 4, takeProfitPct: 10 } }).success).toBe(true);
  });
});

describe("evaluate", () => {
  test("opens when attention and smart money agree, sized by margin and leverage", () => {
    const d = evaluate(rule, flat, { now: T, price: 100_000, attention: rising, netflowUsd: 250_000 });
    expect(d).toMatchObject({ action: "open", side: "long", marginUsdc: 50, leverage: 2, notionalUsdc: 100, size: 0.001 });
    if (d.action === "open") expect(d.signal.attentionChangePct).toBeCloseTo(37.5);
  });

  test.each([
    [{ ...flat, killed: true }, 250_000, rising, "paused"],
    [{ ...flat, realizedTodayUsdc: -20 }, 250_000, rising, "daily loss limit reached"],
    [{ ...flat, lastExitAt: T - 600 }, 250_000, rising, "cooling down after the last trade"],
    [flat, -1, rising, "smart money is not buying"],
    [flat, null, rising, "no smart-money reading"],
    [flat, 250_000, [{ t: T - 60, v: 55 }], "not enough attention history yet"],
    [flat, 250_000, [{ t: T - 3600, v: 50 }, { t: T - 60, v: 55 }], "attention +10% vs +30% needed"],
  ] as const)("waits: %o", (state, netflow, attention, reason) => {
    expect(evaluate(rule, state as RuleState, { now: T, price: 100_000, attention, netflowUsd: netflow })).toEqual({ action: "wait", reason });
  });

  test("falling-attention rules fire on a drop", () => {
    const short = ruleSchema.parse({ ...rule, entry: { ...rule.entry, attentionChangePct: -20, side: "short", smartMoney: "any" } });
    const falling = [
      { t: T - 3600, v: 50 },
      { t: T - 60, v: 35 },
    ];
    expect(evaluate(short, flat, { now: T, price: 100, attention: falling, netflowUsd: null }).action).toBe("open");
    expect(evaluate(short, flat, { now: T, price: 100, attention: rising, netflowUsd: null }).action).toBe("wait");
  });

  test("closes on stop, take-profit, time limit or pause, and holds otherwise", () => {
    const open: RuleState = { ...flat, position: { side: "long", entryPrice: 100, size: 1, marginUsdc: 50, leverage: 2, openedAt: T - 600 } };
    const at = (price: number, s: RuleState = open, now = T) => evaluate(rule, s, { now, price, attention: rising, netflowUsd: 1 });
    expect(at(95)).toMatchObject({ action: "close", reason: "stop" });
    expect(at(110)).toMatchObject({ action: "close", reason: "take_profit" });
    expect(at(103)).toMatchObject({ action: "hold", reason: "price +3.0% from entry" });
    expect(at(103, { ...open, killed: true })).toMatchObject({ action: "close", reason: "kill" });
    const timed = ruleSchema.parse({ ...rule, exits: { ...rule.exits, maxHoldMin: 5 } });
    expect(evaluate(timed, open, { now: T, price: 101, attention: rising, netflowUsd: 1 })).toMatchObject({ action: "close", reason: "max_hold" });
    // A short gains when the price falls.
    const short: RuleState = { ...flat, position: { ...open.position!, side: "short" } };
    expect(at(90, short)).toMatchObject({ action: "close", reason: "take_profit" });
  });

  test("caps the position at the rule's maximum", () => {
    const capped = ruleSchema.parse({ ...rule, size: { marginUsdc: 50, leverage: 2 }, limits: { ...rule.limits, maxPositionUsdc: 100 } });
    const d = evaluate(capped, flat, { now: T, price: 50, attention: rising, netflowUsd: 1 });
    expect(d).toMatchObject({ action: "open", notionalUsdc: 100, marginUsdc: 50, size: 2 });
  });
});

describe("backtest", () => {
  const anyMoney = ruleSchema.parse({ ...rule, entry: { ...rule.entry, smartMoney: "any" }, limits: { ...rule.limits, cooldownMin: 0 } });
  const candles = (closes: number[], extremes: Partial<Record<number, { h?: number; l?: number }>> = {}): Candle[] =>
    closes.map((c, i) => ({ t: T + i * 300, o: c, h: extremes[i]?.h ?? c, l: extremes[i]?.l ?? c, c }));
  const attention = [
    { t: T - 7200, v: 40 },
    { t: T + 100, v: 60 },
  ];

  test("enters on the signal and takes profit inside a candle", () => {
    const patient = ruleSchema.parse({ ...anyMoney, limits: { ...anyMoney.limits, cooldownMin: 60 } });
    const r = backtest({ rule: patient, candles: candles([100, 100, 104, 108], { 3: { h: 111 } }), resolutionSec: 300, attention, netflow: [], feeBps: 0, slippageBps: 0 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ side: "long", entryPrice: 100, reason: "take_profit" });
    expect(r.trades[0]!.exitPrice).toBeCloseTo(110);
    // 100 USDC notional, +10%.
    expect(r.trades[0]!.pnlUsdc).toBeCloseTo(10);
    expect(r.stats).toMatchObject({ trades: 1, wins: 1, winRate: 1 });
  });

  test("assumes the stop first when a candle touched both", () => {
    const r = backtest({ rule: anyMoney, candles: candles([100, 100], { 1: { h: 120, l: 90 } }), resolutionSec: 300, attention, netflow: [], feeBps: 0, slippageBps: 0 });
    expect(r.trades[0]).toMatchObject({ reason: "stop", exitPrice: 95 });
    expect(r.trades[0]!.pnlUsdc).toBeCloseTo(-5);
  });

  test("charges fees and slippage on both fills", () => {
    const r = backtest({ rule: anyMoney, candles: candles([100, 100], { 1: { h: 111 } }), resolutionSec: 300, attention, netflow: [], feeBps: 5, slippageBps: 10 });
    const t = r.trades[0]!;
    expect(t.entryPrice).toBeCloseTo(100.1);
    expect(t.exitPrice).toBeCloseTo(100.1 * 1.1 * 0.999);
    expect(t.feesUsdc).toBeGreaterThan(0.1);
    expect(t.pnlUsdc).toBeLessThan(10);
  });

  test("stops opening for the day at the loss limit, then resumes the next day", () => {
    const tight = ruleSchema.parse({ ...anyMoney, limits: { ...anyMoney.limits, maxDailyLossUsdc: 4 } });
    // Every candle dips 6%: each trade stops out for -5.
    const dips = Array.from({ length: 8 }, (_, i) => ({ t: T + i * 300, o: 100, h: 100, l: 94, c: 100 }));
    const r = backtest({ rule: tight, candles: dips, resolutionSec: 300, attention, netflow: [], feeBps: 0, slippageBps: 0 });
    expect(r.trades.filter((t) => t.reason === "stop")).toHaveLength(1);
    // The next day attention jumps again, and the limit has reset.
    const nextDay = [...dips, ...Array.from({ length: 3 }, (_, i) => ({ t: T + 86_400 + i * 300, o: 100, h: 100, l: 94, c: 100 }))];
    const twoDays = [...attention, { t: T + 82_000, v: 40 }, { t: T + 86_000, v: 60 }];
    expect(backtest({ rule: tight, candles: nextDay, resolutionSec: 300, attention: twoDays, netflow: [], feeBps: 0, slippageBps: 0 }).trades.filter((t) => t.reason === "stop")).toHaveLength(2);
  });

  test("re-enters after the cooldown while the signal holds", () => {
    const r = backtest({ rule: anyMoney, candles: candles([100, 100, 104, 108], { 3: { h: 111 } }), resolutionSec: 300, attention, netflow: [], feeBps: 0, slippageBps: 0 });
    expect(r.trades.map((t) => t.reason)).toEqual(["take_profit", "end_of_data"]);
    expect(r.warnings).toContain("a position was still open at the end and is closed at the last price");
  });

  test("reports data gaps", () => {
    const r = backtest({ rule, candles: candles([100, 101]), resolutionSec: 300, attention: [], netflow: [], feeBps: 0, slippageBps: 0 });
    expect(r.trades).toHaveLength(0);
    expect(r.warnings).toEqual(["the trend has no attention history in this period", "no smart-money history, so the rule never fires in the backtest"]);
    expect(backtest({ rule, candles: [], resolutionSec: 300, attention, netflow: [], feeBps: 0, slippageBps: 0 }).warnings).toEqual(["no price history for this market"]);
  });
});

describe("stats", () => {
  test("win rate, profit factor and drawdown", () => {
    const t = (closedAt: number, pnl: number) => ({ side: "long" as const, openedAt: 0, closedAt, entryPrice: 1, exitPrice: 1, size: 1, marginUsdc: 10, pnlUsdc: pnl, feesUsdc: 0, reason: "x" });
    const s = stats([t(1, 10), t(2, -4), t(3, -8), t(4, 5)]);
    expect(s).toMatchObject({ trades: 4, wins: 2, losses: 2, winRate: 0.5, pnlUsdc: 3, maxDrawdownUsdc: 12, bestUsdc: 10, worstUsdc: -8 });
    expect(s.profitFactor).toBeCloseTo(15 / 12);
    expect(s.returnOnMarginPct).toBeCloseTo(7.5);
    expect(stats([]).winRate).toBe(0);
  });
});

describe("copy-trading", () => {
  const follow = followSettingsSchema.parse({ mode: "ratio", ratio: 0.5, maxMarginUsdc: 100, maxLeverage: 3, maxDailyLossUsdc: 50, maxSlippagePct: 0.5, maxOpenLossUsdc: 30 });
  const at = (price: number, realizedTodayUsdc = 0, openPnlUsdc = 0, maxLeverage = 10) => ({ price, realizedTodayUsdc, openPnlUsdc, maxLeverage });

  test("diffs a leader's position into opens, increases, decreases, closes and flips", () => {
    const long = (size: number) => ({ side: "long" as const, size, marginUsdc: size * 20 });
    expect(diffHolding("BTC", null, long(1), 100)).toEqual([{ kind: "open", market: "BTC", side: "long", size: 1, leverage: 5 }]);
    expect(diffHolding("BTC", long(1), long(1.5), 100)).toEqual([{ kind: "increase", market: "BTC", side: "long", size: 0.5, leverage: 5 }]);
    expect(diffHolding("BTC", long(2), long(0.5), 100)).toEqual([{ kind: "decrease", market: "BTC", side: "long", fraction: 0.75 }]);
    expect(diffHolding("BTC", long(1), null, 100)).toEqual([{ kind: "close", market: "BTC", side: "long" }]);
    expect(diffHolding("BTC", long(1), { side: "short", size: 1, marginUsdc: 50 }, 100).map((c) => c.kind)).toEqual(["close", "open"]);
    expect(diffHolding("BTC", long(1), long(1), 100)).toEqual([]);
  });

  test("carries the leader's fill: the entry of an opening, and what an increase added at", () => {
    const at100 = { side: "long" as const, size: 1, marginUsdc: 20, entryPrice: 100 };
    expect(diffHolding("BTC", null, at100, 101)).toEqual([{ kind: "open", market: "BTC", side: "long", size: 1, leverage: 5.05, price: 100 }]);
    // 1 at 100, then 3 at an average of 103: the 2 added filled at 104.5.
    const [inc] = diffHolding("BTC", at100, { ...at100, size: 3, entryPrice: 103 }, 104);
    expect(inc).toMatchObject({ kind: "increase", size: 2 });
    expect(inc!.kind === "increase" && inc!.price).toBeCloseTo(104.5);
    // An earlier snapshot without an entry gives no fill price rather than a wrong one.
    expect(diffHolding("BTC", { ...at100, entryPrice: null }, { ...at100, size: 3, entryPrice: 103 }, 104)[0]).not.toHaveProperty("price");
    expect(diffHolding("BTC", at100, { side: "short", size: 1, marginUsdc: 20, entryPrice: 99 }, 99)[1]).toMatchObject({ kind: "open", side: "short", price: 99 });
  });

  test("sizes by ratio, caps leverage and margin, and mirrors reductions proportionally", () => {
    const open = mirror({ kind: "open", market: "BTC", side: "long", size: 2, leverage: 5 }, follow, null, at(100));
    // Half the leader's 2 BTC at 100 is 100 notional; leverage capped to 3: margin 33.3.
    expect(open).toMatchObject({ action: "open", side: "long", leverage: 3 });
    if (open.action === "open") {
      expect(open.marginUsdc).toBeCloseTo(100 / 3);
      expect(open.size).toBeCloseTo(1);
      expect(open.worstPrice).toBeCloseTo(100.5);
    }
    const held = { side: "long" as const, size: 1, marginUsdc: 95 };
    expect(mirror({ kind: "increase", market: "BTC", side: "long", size: 2, leverage: 3 }, follow, held, at(100))).toMatchObject({ action: "open", marginUsdc: 5 });
    expect(mirror({ kind: "decrease", market: "BTC", side: "long", fraction: 0.25 }, follow, held, at(100))).toEqual({ action: "reduce", market: "BTC", side: "long", size: 0.25 });
    expect(mirror({ kind: "close", market: "BTC", side: "long" }, follow, null, at(100))).toMatchObject({ action: "skip" });
    const fixed = { ...follow, mode: "fixed" as const, fixedMarginUsdc: 20 };
    expect(mirror({ kind: "open", market: "BTC", side: "short", size: 9, leverage: 2 }, fixed, null, at(100))).toMatchObject({ action: "open", marginUsdc: 20, size: 0.4 });
    expect(mirror({ kind: "increase", market: "BTC", side: "short", size: 9, leverage: 2 }, fixed, { side: "short", size: 0.4, marginUsdc: 20 }, at(100))).toMatchObject({ action: "skip", reason: "fixed size copies openings only" });
  });

  test("never copies above the market's leverage cap, keeping the margin the follow sets", () => {
    const loose = { ...follow, maxLeverage: 20, maxMarginUsdc: 1000 };
    // The leader at 20x: a session copies at the order guard's 10x, with the ratio's notional.
    const capped = mirror({ kind: "open", market: "BTC", side: "long", size: 2, leverage: 20 }, loose, null, at(100));
    expect(capped).toMatchObject({ action: "open", leverage: 10, marginUsdc: 10, size: 1 });
    // A tighter cap (the market's own limit, or a guard deployed lower) wins too.
    expect(mirror({ kind: "open", market: "BTC", side: "long", size: 2, leverage: 20 }, loose, null, at(100, 0, 0, 5))).toMatchObject({ leverage: 5, marginUsdc: 20, size: 1 });
    // Fixed margin: the size shrinks with the leverage instead.
    const fixed = { ...loose, mode: "fixed" as const, fixedMarginUsdc: 20 };
    expect(mirror({ kind: "open", market: "BTC", side: "short", size: 9, leverage: 15 }, fixed, null, at(100))).toMatchObject({ leverage: 10, marginUsdc: 20, size: 2 });
  });

  test("limits each copied opening to the follow's slippage from the leader's fill and the mark", () => {
    // Long at 100 with 0.5%: the limit is 100.5 from the fill; with the mark at 100.2 that is the tighter one.
    expect((copyLimit("long", 100.2, 100, 0.5) as { worstPrice: number }).worstPrice).toBeCloseTo(100.5);
    // The market fell after the leader bought: the mark's limit is tighter.
    expect((copyLimit("long", 99, 100, 0.5) as { worstPrice: number }).worstPrice).toBeCloseTo(99.495);
    // A leader filling far above the market cannot drag the follower's limit up with it.
    expect((copyLimit("long", 100, 110, 0.5) as { worstPrice: number }).worstPrice).toBeCloseTo(100.5);
    // Shorts mirror it.
    expect((copyLimit("short", 99.9, 100, 0.5) as { worstPrice: number }).worstPrice).toBeCloseTo(99.5);
    // Without a fill price, only the mark bounds it.
    expect((copyLimit("short", 100, undefined, 0.5) as { worstPrice: number }).worstPrice).toBeCloseTo(99.5);
    // The market already moved past the limit: skipped, with how far it went.
    expect(copyLimit("long", 101, 100, 0.5)).toEqual({ skip: "the price moved 1.00% from the leader's fill, past your 0.5% limit" });
    expect(copyLimit("short", 99, 100, 0.5)).toEqual({ skip: "the price moved 1.00% from the leader's fill, past your 0.5% limit" });
    // Follows stored with more than the most a copy may take (the order guard's room) are held to 1%.
    expect((copyLimit("long", 100, undefined, 3) as { worstPrice: number }).worstPrice).toBeCloseTo(101);
    expect(copyLimit("long", 101.5, 100, 3)).toEqual({ skip: "the price moved 1.50% from the leader's fill, past your 1% limit" });
    expect(mirror({ kind: "open", market: "BTC", side: "long", size: 2, leverage: 5, price: 100 }, follow, null, at(101))).toEqual({
      action: "skip",
      market: "BTC",
      reason: "the price moved 1.00% from the leader's fill, past your 0.5% limit",
    });
    // Closes never wait on a limit: the follower is not left holding the leader's exit.
    expect(mirror({ kind: "close", market: "BTC", side: "long" }, follow, { side: "long", size: 1, marginUsdc: 10 }, at(90))).toMatchObject({ action: "reduce", size: 1 });
  });

  test("open losses count against the daily limit, and the loss cap stops new copies", () => {
    const opening = { kind: "open" as const, market: "BTC", side: "long" as const, size: 2, leverage: 5 };
    expect(mirror(opening, follow, null, at(100, -50))).toEqual({ action: "skip", market: "BTC", reason: "daily loss limit reached" });
    expect(mirror(opening, follow, null, at(100, -25, -25))).toEqual({ action: "skip", market: "BTC", reason: "daily loss limit reached" });
    expect(mirror(opening, follow, null, at(100, 0, -30))).toEqual({ action: "skip", market: "BTC", reason: "open copies are at the loss cap" });
    expect(mirror(opening, follow, null, at(100, -10, -10))).toMatchObject({ action: "open" });
    const positions = [
      { market: "BTC", side: "long" as const, size: 2, entryPrice: 100 },
      { market: "ETH", side: "short" as const, size: 1, entryPrice: 50 },
      { market: "SOL", side: "long" as const, size: 5, entryPrice: null },
    ];
    expect(openPnl(positions, new Map([["BTC", 95], ["ETH", 52], ["SOL", 10]]))).toBeCloseTo(-12);
    // No mark yet: counted flat rather than guessed.
    expect(openPnl(positions, new Map([["BTC", 95]]))).toBeCloseTo(-10);
  });

  test("settings: defaults for slippage and the loss cap, also for follows stored before them", () => {
    const parsed = followSettingsSchema.parse({ mode: "ratio", maxMarginUsdc: 50, maxDailyLossUsdc: 25 });
    expect(parsed).toMatchObject({ ratio: 1, maxLeverage: 3, maxSlippagePct: 0.3, maxOpenLossUsdc: 25 });
    expect(followSettingsSchema.safeParse({ ...parsed, maxSlippagePct: 5 }).success).toBe(false);
    expect(followSettingsSchema.safeParse({ ...parsed, maxSlippagePct: 1 }).success).toBe(true);
    expect(followSettingsSchema.safeParse({ ...parsed, maxSlippagePct: 1.5 }).success).toBe(false);
    expect(followSettingsSchema.safeParse({ ...parsed, maxSlippagePct: 0.01 }).success).toBe(false);
    expect(followSettingsSchema.safeParse({ ...parsed, maxOpenLossUsdc: 0 }).success).toBe(false);
    expect(followSettingsSchema.safeParse({ ...parsed, mode: "fixed", fixedMarginUsdc: 0 }).success).toBe(false);
    expect(withFollowDefaults({ mode: "fixed", ratio: 1, fixedMarginUsdc: 20, maxMarginUsdc: 50, maxLeverage: 2, maxDailyLossUsdc: 15 })).toMatchObject({ maxSlippagePct: 0.3, maxOpenLossUsdc: 15 });
  });
});

describe("sealed grants", () => {
  const owner = "account-a1";
  const sessionKey = "session-key-b2";

  test("only the executor's private key opens a box, bound to its account and key; tampering is detected", async () => {
    const { boxKeyId, generateSealKeyPair, seal, sealKeyId, open } = await import("../src");
    const executor = await generateSealKeyPair();
    const other = await generateSealKeyPair();
    const box = await seal("secret-session-key", executor.publicKey, { owner, sessionKey });
    expect(box.startsWith("v2.")).toBe(true);
    expect(await open(box, executor.privateKey, { owner, sessionKey })).toBe("secret-session-key");
    // Case does not matter; the characters do.
    expect(await open(box, executor.privateKey, { owner: owner.toUpperCase(), sessionKey })).toBe("secret-session-key");
    await expect(open(box, other.privateKey, { owner, sessionKey })).rejects.toThrow("another executor key");
    // Moved to another account or presented as another key, it does not open.
    await expect(open(box, executor.privateKey, { owner: sessionKey, sessionKey })).rejects.toThrow();
    await expect(open(box, executor.privateKey, { owner, sessionKey: owner })).rejects.toThrow();
    const bytes = Buffer.from(box.slice(3), "base64url");
    bytes[bytes.length - 1]! ^= 1;
    await expect(open(`v2.${bytes.toString("base64url")}`, executor.privateKey, { owner, sessionKey })).rejects.toThrow();
    // Each box uses a fresh ephemeral key and IV.
    expect(await seal("secret-session-key", executor.publicKey, { owner, sessionKey })).not.toBe(box);
    // The API can tell which executor key a box is for, without opening it.
    expect(boxKeyId(box)).toBe(await sealKeyId(executor.publicKey));
    expect(boxKeyId(box)).not.toBe(await sealKeyId(other.publicKey));
    expect(boxKeyId("v2.@@")).toBeNull();
    await expect(seal("x", executor.publicKey, { owner: "", sessionKey })).rejects.toThrow("not an account or key id");
  });

  test("boxes the API server sealed before v2 still open", async () => {
    const { generateSealKeyPair, open } = await import("../src");
    const executor = await generateSealKeyPair();
    const box = await sealV1("legacy-session-key", executor.publicKey);
    expect(await open(box, executor.privateKey, { owner, sessionKey })).toBe("legacy-session-key");
  });
});

/** The v1 box exactly as the API server sealed it: ephemeral key | IV | ciphertext, AAD the ephemeral key. */
async function sealV1(plaintext: string, recipientPublicKey: string): Promise<string> {
  const recipient = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(recipientPublicKey, "base64url")), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: ephRaw, info: new TextEncoder().encode("tredio-autopilot-grant-v1") }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ephRaw }, key, new TextEncoder().encode(plaintext)));
  return Buffer.concat([ephRaw, iv, ct]).toString("base64url");
}
