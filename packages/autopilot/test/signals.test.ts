import { describe, expect, test } from "bun:test";
import { diffHolding } from "../src/copy";
import { epochOf, identityOfLeader, matchesCommitment, openSignal, sealSignal, SIGNAL_EPOCH_SEC, type Signal, signalCommitment, signalHoldings, signalInputSchema, signalLeader, signalMessage, viewingKey } from "../src/signals";

const LEADER = "a".repeat(64);
const open = (over: Partial<Signal> = {}): Signal => ({ leader: LEADER, kind: "open", market: "BTC", side: "long", marginUsdc: 100, leverage: 5, note: "breakout", issuedAt: 1_794_000_000, price: 100_000, ...over });

describe("private signals", () => {
  test("the signed message and its commitment cover every field the leader chose", async () => {
    const s = open();
    const note = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("breakout"))), (x) => x.toString(16).padStart(2, "0")).join("");
    expect(await signalMessage(LEADER, s)).toBe(`Tredio signal\nleader: ${LEADER}\nkind: open\nmarket: BTC\nside: long\nmargin: 100\nleverage: 5\nnote: ${note}\nissued: 1794000000`);
    const c = await signalCommitment(LEADER, s);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(await signalCommitment(LEADER, { ...s, leverage: 6 })).not.toBe(c);
    expect(await signalCommitment(LEADER, { ...s, note: "breakout!" })).not.toBe(c);
    // The stamped mark is not part of what the leader signed.
    expect(await matchesCommitment({ ...s, price: 1 }, c)).toBe(true);
    expect(await matchesCommitment({ ...s, side: "short" }, c)).toBe(false);
  });

  test("a week's viewing key opens that week's signals only, and only under the right commitment", async () => {
    const secret = new Uint8Array(32).fill(7);
    const week = epochOf(1_794_000_000);
    const key = await viewingKey(secret, LEADER, week);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await viewingKey(secret, LEADER, week + 1)).not.toBe(key);
    expect(await viewingKey(secret, "b".repeat(64), week)).not.toBe(key);
    const s = open();
    const c = await signalCommitment(LEADER, s);
    const box = await sealSignal(key, s, c);
    expect(await openSignal(key, box, c)).toEqual(s);
    await expect(openSignal(await viewingKey(secret, LEADER, week + 1), box, c)).rejects.toThrow();
    await expect(openSignal(key, box, "0".repeat(64))).rejects.toThrow();
    expect(epochOf(SIGNAL_EPOCH_SEC * 3 + 5)).toBe(3);
  });

  test("signals add up to positions that copy-trading diffs into copies", () => {
    const t = 1_794_000_000;
    const a = open({ issuedAt: t });
    const b = open({ issuedAt: t + 60, marginUsdc: 50, leverage: 4, price: 110_000 });
    const held = signalHoldings([b, a]).get("BTC")!;
    expect(held.side).toBe("long");
    expect(held.marginUsdc).toBe(150);
    expect(held.size).toBeCloseTo(500 / 100_000 + 200 / 110_000, 12);
    // The second signal is an increase at its own mark.
    const before = signalHoldings([a]).get("BTC")!;
    const [change] = diffHolding("BTC", before, held, 110_000);
    expect(change).toMatchObject({ kind: "increase", side: "long" });
    expect((change as { price: number }).price).toBeCloseTo(110_000, 6);
    // A close ends it; an opening on the other side replaces it; a market outside Autopilot's is ignored.
    expect(signalHoldings([a, b, open({ kind: "close", issuedAt: t + 120, marginUsdc: null, leverage: null })]).size).toBe(0);
    expect(signalHoldings([a, open({ issuedAt: t + 1, side: "short" })]).get("BTC")?.side).toBe("short");
    expect(signalHoldings([open({ market: "DOGE" })]).size).toBe(0);
  });

  test("inputs and leader ids", () => {
    expect(signalInputSchema.safeParse({ kind: "open", market: "ETH", side: "short", marginUsdc: 20, leverage: 3 }).success).toBe(true);
    expect(signalInputSchema.safeParse({ kind: "open", market: "ETH", side: "short" }).success).toBe(false);
    expect(signalInputSchema.safeParse({ kind: "open", market: "DOGE", side: "long", marginUsdc: 20, leverage: 3 }).success).toBe(false);
    expect(signalInputSchema.safeParse({ kind: "open", market: "BTC", side: "long", marginUsdc: 20, leverage: 11 }).success).toBe(false);
    expect(signalInputSchema.safeParse({ kind: "close", market: "BTC", side: "long" }).success).toBe(true);
    expect(identityOfLeader(signalLeader(LEADER))).toBe(LEADER);
    expect(identityOfLeader("0x972dac64d693f387cd089f0efcda320c71097a2c")).toBeNull();
  });
});
