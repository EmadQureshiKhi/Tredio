import { describe, expect, test } from "bun:test";
import { generateSealKeyPair, open, seal, sealKeyId } from "@tredio/autopilot";
import { loadConfig } from "../src/config";
import type { ExecutorStatus } from "../src/executor";
import { healthApp, healthReport } from "../src/health";
import { sealPublicKey } from "../src/seal";
import { grantKeyProblem } from "../src/venues";
import { ed25519Key, T } from "./fakes";

const status = (s: Partial<ExecutorStatus> = {}): ExecutorStatus => ({ lastTickAt: T - 5, lastTickMs: 120, lastError: null, failingTicks: 0, kill: { engaged: false, reason: null }, rules: 2, ticks: 9, ...s });
const stats = async () => ({ rules: 2, grants: 3, follows: 1, leaders: 1, inFlight: 0, today: { filled: 4, unfilled: 1, failed: 0 } });
const wallet = (gas: string | null) => async () => ({ label: "Bot", account: "tredio-bot.testnet", balance: "1.2", min: null, gasKeys: gas === null ? [] : [{ publicKey: "ed25519:k", balance: gas, nonces: 4 }] });
const base = { network: "testnet", tickSec: 15, sealKeyId: "0123456789abcdef", now: () => T * 1000 };

describe("health", () => {
  test("the shared shape: ok, the bot's wallet, alerts, last error and work, facts and flags", async () => {
    const r = await healthReport({ ...base, status: () => status(), stats, wallet: wallet("0.35") });
    expect(r.httpStatus).toBe(200);
    expect(r.body).toMatchObject({ ok: true, service: "autopilot", network: "testnet", alerts: {}, lastError: null, lastWorkAt: T - 5, flags: [] });
    expect(r.body.wallets).toEqual([{ label: "Bot", account: "tredio-bot.testnet", balance: "1.2", min: null, gasKeys: [{ publicKey: "ed25519:k", balance: "0.35", nonces: 4 }] }]);
    expect(r.body.facts).toContainEqual({ label: "Orders today", value: "4 filled, 1 unfilled, 0 failed", tone: undefined });
    expect(r.body.facts).toContainEqual({ label: "Kill switch", value: "off", tone: "ok" });
  });

  test("the kill switch is a flag; a stale loop, a dry gas key or a missing seal key are alerts", async () => {
    const r = await healthReport({ ...base, sealKeyId: null, status: () => status({ lastTickAt: T - 100, kill: { engaged: true, reason: "drill" } }), stats, wallet: wallet("0.29") });
    expect(r.httpStatus).toBe(503);
    expect(r.body.flags).toEqual(["kill switch engaged", "no seal key: grants cannot trade"]);
    expect(Object.keys(r.body.alerts as object).sort()).toEqual(["gas", "grants", "stale"]);
    const down = await healthReport({ ...base, status: () => status(), stats: async () => Promise.reject(new Error("connection refused")), wallet: async () => null });
    expect(down.body).toMatchObject({ ok: false, wallets: [], alerts: { database: "database unreachable: connection refused" } });
  });

  test("/live answers whatever the database says", async () => {
    const app = healthApp({ ...base, status: () => status(), stats: async () => Promise.reject(new Error("down")), wallet: async () => null });
    expect(await (await app.request("/live")).json()).toEqual({ live: true });
    expect((await app.request("/health")).status).toBe(503);
  });
});

describe("seal key", () => {
  test("the public half printed at start is the one the app seals to", async () => {
    const pair = await generateSealKeyPair();
    const derived = await sealPublicKey(pair.privateKey);
    expect(derived).toEqual({ publicKey: pair.publicKey, keyId: await sealKeyId(pair.publicKey) });
    const key = ed25519Key();
    const box = await seal(key.secretKey, derived.publicKey, { owner: "0uuser", sessionKey: key.publicKey });
    expect(await open(box, pair.privateKey, { owner: "0uuser", sessionKey: key.publicKey })).toBe(key.secretKey);
  });
});

describe("config and grant keys", () => {
  test("the bot needs its account and session key together", () => {
    const key = ed25519Key();
    expect(() => loadConfig({ DATABASE_URL: "postgres://x@localhost/y", AUTOPILOT_BOT_ACCOUNT: "tredio-bot.testnet" })).toThrow("together");
    const c = loadConfig({ DATABASE_URL: "postgres://x@localhost/y", AUTOPILOT_BOT_ACCOUNT: "tredio-bot.testnet", AUTOPILOT_BOT_SESSION_KEY: key.secretKey });
    expect(c.bot).toEqual({ account: "tredio-bot.testnet", secretKey: key.secretKey, sessionKey: key.publicKey });
    expect(c.PORT).toBe(4400);
    expect(c.SESSION_GAS_MIN_NEAR).toBe(31n * 10n ** 22n);
  });

  test("a waiting grant key must be the account's own gas key for session calls", () => {
    expect(grantKeyProblem("0uuser", { kind: "function_call", receiverId: "0uuser", methodNames: ["session_call"], gasKey: true })).toBeNull();
    expect(grantKeyProblem("0uuser", { kind: "full" })).toContain("not limited");
    expect(grantKeyProblem("0uuser", { kind: "function_call", receiverId: "usdc.tredio.testnet", methodNames: ["session_call"], gasKey: true })).toContain("not limited");
    expect(grantKeyProblem("0uuser", { kind: "function_call", receiverId: "0uuser", methodNames: ["session_call"], gasKey: false })).toBe("the key is not a gas key");
    expect(grantKeyProblem("0uuser", null)).toBe("the key is not on the account");
  });
});
