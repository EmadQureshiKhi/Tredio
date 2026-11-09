import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Encode, rpcEndpoints, Viewer } from "@tredio/chain";
import { tradingFromEnv } from "../src/index";
import { NO_POLICY, parsePolicy, PolicyRefusal, policyJson, SpendGuard, SpendLedger } from "../src/policy";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 9, 12);
const USDC = 1_000_000n;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tredio-policy-"));
  file = join(dir, "ledger.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const POLICY = { dailyCapUsdc: "20", tools: { buy_outcome: { maxUsdc: "10" }, open_perp: { maxUsdc: 15 }, sell_outcome: true, close_perp: {} } };
const guardAt = (clock: { now: number }, policy = parsePolicy(POLICY)) => new SpendGuard(policy, new SpendLedger(file, () => clock.now));
const reserve = (g: SpendGuard, tool: "buy_outcome" | "open_perp" | "sell_outcome" | "buy_coin", usdc: bigint) => g.reserve({ tool, account: "agent.testnet", signer: "account", spend: usdc, args: { usdc: String(usdc / USDC) } });

describe("policy file", () => {
  test("reads caps as USDC and names the allowed tools", () => {
    const p = parsePolicy(POLICY);
    expect(p.dailyCap).toBe(20n * USDC);
    expect(p.tools.buy_outcome).toEqual({ maxPerCall: 10n * USDC });
    expect(p.tools.open_perp).toEqual({ maxPerCall: 15n * USDC });
    expect(p.tools.sell_outcome).toEqual({ maxPerCall: null });
    expect(p.tools.close_perp).toEqual({ maxPerCall: null });
    expect(p.tools.buy_coin).toBeUndefined();
    expect(policyJson(p).tools.buy_coin).toEqual({ allowed: false });
    expect(policyJson(p).tools.open_perp).toEqual({ allowed: true, maxUsdcPerCall: "15" });
    expect(parsePolicy({ dailyCapUsdc: "0.5", tools: {}, ledgerFile: "spend.json" })).toEqual({ dailyCap: 500_000n, tools: {}, ledgerFile: "spend.json" });
  });

  test("refuses a policy that is unclear", () => {
    expect(() => parsePolicy({ dailyCapUsdc: "20", tools: { buy_outcome: true } })).toThrow('tools.buy_outcome spends USDC, so it needs a "maxUsdc" above 0');
    expect(() => parsePolicy({ dailyCapUsdc: "20", tools: { buy_outcome: { maxUsdc: "0" } } })).toThrow("needs a");
    expect(() => parsePolicy({ dailyCapUsdc: "20", tools: { sell_coin: { maxUsdc: "5" } } })).toThrow('tools.sell_coin spends no USDC; drop its "maxUsdc"');
    expect(() => parsePolicy({ dailyCapUsdc: "20", tools: { transfer_all: true } })).toThrow("tools");
    expect(() => parsePolicy({ dailyCapUsdc: "1.0000001", tools: {} })).toThrow("not a USDC amount");
    expect(() => parsePolicy({ dailyCapUsdc: -1, tools: {} })).toThrow("the trading policy is invalid");
    expect(() => parsePolicy({ tools: {} })).toThrow("dailyCapUsdc");
    expect(() => parsePolicy({ dailyCapUsdc: "5", tools: {}, maxLeverage: 3 })).toThrow("the trading policy is invalid");
  });
});

describe("spend guard", () => {
  test("without a policy no tool may send", () => {
    const g = new SpendGuard(NO_POLICY, new SpendLedger(file));
    const c = g.check("sell_outcome", 0n);
    expect(c.allowed).toBe(false);
    expect(c.reason).toContain("does not allow sell_outcome");
    expect(() => reserve(g, "sell_outcome", 0n)).toThrow(PolicyRefusal);
    // A refusal writes nothing and leaves no lock behind.
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("allowlist, cap per call and daily cap", () => {
    const clock = { now: T0 };
    const g = guardAt(clock);
    expect(g.check("buy_coin", USDC)).toMatchObject({ allowed: false, reason: expect.stringContaining("does not allow buy_coin") });
    expect(g.check("buy_outcome", 11n * USDC)).toMatchObject({ allowed: false, reason: "11 USDC is above buy_outcome's cap of 10 USDC per call", maxUsdcPerCall: "10" });
    expect(g.check("buy_outcome", 10n * USDC)).toEqual({ allowed: true, reason: null, maxUsdcPerCall: "10", dailyCapUsdc: "20", spentTodayUsdc: "0", leftTodayUsdc: "20" });
    reserve(g, "buy_outcome", 10n * USDC);
    reserve(g, "open_perp", 8n * USDC);
    const over = g.check("open_perp", 3n * USDC);
    expect(over).toMatchObject({ allowed: false, spentTodayUsdc: "18", leftTodayUsdc: "2" });
    expect(over.reason).toBe("3 USDC would bring today's spend (UTC) to 21 USDC, above the daily cap of 20 USDC; 2 USDC is left today");
    expect(() => reserve(g, "open_perp", 3n * USDC)).toThrow("above the daily cap");
    expect(g.check("open_perp", 2n * USDC).allowed).toBe(true);
    // Sales spend nothing, so the daily cap never stops them.
    expect(g.check("sell_outcome", 0n).allowed).toBe(true);
  });

  test("a check is only a check; a reservation counts until it settles as failed or refused", () => {
    const clock = { now: T0 };
    const g = guardAt(clock);
    g.check("buy_outcome", 10n * USDC);
    expect(g.summary().spentUsdc).toBe("0");
    const a = reserve(g, "buy_outcome", 5n * USDC);
    const b = reserve(g, "buy_outcome", 4n * USDC);
    const c = reserve(g, "open_perp", 3n * USDC);
    const d = reserve(g, "open_perp", 2n * USDC);
    expect(g.summary().spentUsdc).toBe("14");
    g.settle(a.id, { status: "sent", hash: "Hash1" });
    g.settle(b.id, { status: "failed", hash: "Hash2", error: "swap output below the minimum" });
    g.settle(c.id, { status: "refused", hash: "Hash3", error: "index stale" });
    g.settle(d.id, { status: "unknown", hash: "Hash4" });
    const s = g.summary();
    expect(s).toMatchObject({ day: "2026-11-09", spentUsdc: "7", leftUsdc: "13" });
    expect(s.trades.map((e) => [e.tool, e.usdc, e.status, e.hash])).toEqual([
      ["buy_outcome", "5", "sent", "Hash1"],
      ["buy_outcome", "4", "failed", "Hash2"],
      ["open_perp", "3", "refused", "Hash3"],
      ["open_perp", "2", "unknown", "Hash4"],
    ]);
    expect(s.trades[1]!.error).toBe("swap output below the minimum");
    expect(s.trades[0]!.args).toEqual({ usdc: "5" });
  });

  test("the day's spend survives a restart and resets at UTC midnight", () => {
    const clock = { now: T0 };
    const first = guardAt(clock);
    first.settle(reserve(first, "buy_outcome", 10n * USDC).id, { status: "sent", hash: "Hash1" });
    first.settle(reserve(first, "open_perp", 9n * USDC).id, { status: "sent", hash: "Hash2" });
    // A new server process on the same file.
    const second = guardAt(clock);
    expect(second.summary().spentUsdc).toBe("19");
    expect(() => reserve(second, "buy_outcome", 2n * USDC)).toThrow("1 USDC is left today");
    clock.now = T0 + DAY / 2 - 1;
    expect(second.check("buy_outcome", 2n * USDC).allowed).toBe(false);
    clock.now = T0 + DAY / 2;
    expect(second.check("buy_outcome", 10n * USDC)).toMatchObject({ allowed: true, spentTodayUsdc: "0" });
    expect(second.summary().trades).toEqual([]);
  });

  test("keeps 30 days of entries", () => {
    const clock = { now: T0 };
    const g = guardAt(clock);
    reserve(g, "buy_outcome", USDC);
    clock.now = T0 + 31 * DAY;
    reserve(g, "buy_outcome", USDC);
    expect(g.ledger.entries().length).toBe(1);
  });

  test("a ledger it cannot read stops every trade instead of starting the day over", () => {
    writeFileSync(file, "{ not json");
    const g = guardAt({ now: T0 });
    expect(() => g.check("buy_outcome", USDC)).toThrow("is not valid JSON");
    expect(() => reserve(g, "buy_outcome", USDC)).toThrow("is not valid JSON");
    writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(() => g.summary()).toThrow("has no entries list");
  });

  test("waits for the lock another writer holds, and breaks a stale one", () => {
    const g = guardAt({ now: T0 });
    writeFileSync(`${file}.lock`, "");
    // A lock older than ten seconds belongs to a process that died mid-write.
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${file}.lock`, old, old);
    reserve(g, "buy_outcome", USDC);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(g.summary().spentUsdc).toBe("1");
  });
});

describe("configuration from env", () => {
  const secret = (fill: number) => {
    const seed = new Uint8Array(32).fill(fill);
    return `ed25519:${base58Encode(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]))}`;
  };
  const rpc = rpcEndpoints("testnet");
  const viewer = new Viewer("testnet", rpc);
  const fromEnv = (env: Record<string, string>) => tradingFromEnv(env, "testnet", rpc, viewer);

  test("no key, no trading; a policy without a key is a mistake", () => {
    expect(fromEnv({})).toBeNull();
    expect(() => fromEnv({ TREDIO_POLICY: JSON.stringify(POLICY) })).toThrow("a trading policy is set but no key to trade with");
  });

  test("a NEAR account's own key, its key as the caller identity, the default ledger and no policy", () => {
    const t = fromEnv({ TREDIO_TRADER_ACCOUNT: "Agent.testnet", TREDIO_TRADER_PRIVATE_KEY: secret(1) })!;
    expect(t.signer).toMatchObject({ kind: "account", account: "agent.testnet" });
    expect(t.caller!.identity).toBe(Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(1))).toString("hex"));
    expect(t.guard.policy).toBe(NO_POLICY);
    expect(t.guard.ledger.file).toBe(join(homedir(), ".tredio-mcp", "ledger-testnet.json"));
    expect(t.relayerUrl).toBeNull();
  });

  test("a session key, a separate caller key, a policy file with a ledger beside it, and the relayer", () => {
    const policyFile = join(dir, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ ...POLICY, ledgerFile: "spend/ledger.json" }));
    const t = fromEnv({ TREDIO_SESSION_ACCOUNT: "0uabc", TREDIO_SESSION_KEY: secret(2), TREDIO_CALLER_KEY: secret(3), TREDIO_POLICY_FILE: policyFile, TREDIO_RELAYER_URL: "http://localhost:4100" })!;
    expect(t.signer).toMatchObject({ kind: "session", account: "0uabc" });
    expect(t.caller!.identity).toBe(Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(3))).toString("hex"));
    expect(t.guard.policy.tools.open_perp).toEqual({ maxPerCall: 15n * USDC });
    expect(t.guard.ledger.file).toBe(join(dir, "spend", "ledger.json"));
    expect(t.relayerUrl).toBe("http://localhost:4100");
    expect(fromEnv({ TREDIO_SESSION_ACCOUNT: "0uabc", TREDIO_SESSION_KEY: secret(2), TREDIO_POLICY: JSON.stringify(POLICY), TREDIO_LEDGER_FILE: file })!.guard.ledger.file).toBe(file);
  });

  test("refuses unclear configuration", () => {
    const trader = { TREDIO_TRADER_ACCOUNT: "agent.testnet", TREDIO_TRADER_PRIVATE_KEY: secret(1) };
    expect(() => fromEnv({ ...trader, TREDIO_SESSION_ACCOUNT: "0uabc", TREDIO_SESSION_KEY: secret(2) })).toThrow("set one trading key");
    expect(() => fromEnv({ TREDIO_TRADER_ACCOUNT: "agent.testnet" })).toThrow("set both TREDIO_TRADER_ACCOUNT and TREDIO_TRADER_PRIVATE_KEY, or neither");
    expect(() => fromEnv({ TREDIO_TRADER_ACCOUNT: "not an account!", TREDIO_TRADER_PRIVATE_KEY: secret(1) })).toThrow("is not a NEAR account id");
    expect(() => fromEnv({ ...trader, TREDIO_POLICY: "{" })).toThrow("the trading policy is not valid JSON");
    expect(() => fromEnv({ ...trader, TREDIO_POLICY: JSON.stringify(POLICY), TREDIO_POLICY_FILE: "/x.json" })).toThrow("not both");
    expect(() => fromEnv({ ...trader, TREDIO_POLICY_FILE: join(dir, "missing.json") })).toThrow("could not read the trading policy");
    expect(() => fromEnv({ ...trader, TREDIO_POLICY: JSON.stringify({ dailyCapUsdc: "5", tools: { buy_coin: true } }) })).toThrow("tools.buy_coin spends USDC");
  });
});
