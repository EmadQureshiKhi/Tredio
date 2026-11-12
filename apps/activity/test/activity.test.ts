import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import * as api from "../../../backend/src/social/routes";
import { callNote, postBody } from "../src/content";
import { ROSTER } from "../src/personas";
import { type Holding, isAwake, nextAction, sideFor, type State, type TrendView, USDC } from "../src/plan";
import { Caller, callMessage, identityOf, postMessage, profileMessage, sign } from "../src/social";

/** A repeatable stream of numbers in [0, 1). */
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length]!;
};
const trend = (over: Partial<TrendView> = {}): TrendView => ({ identifier: "topic:world-cup.2", displayName: "World Cup", index: 54.4, change24h: 6.8, series: 45, ...over });
const state = (over: Partial<State> = {}): State => ({ nowSec: 1_794_400_000, usdc: 500n * USDC, trends: [trend()], holdings: [], positions: [], callsToday: 0, callToAnswer: null, ...over });

describe("the roster", () => {
  test("handles fit the API's rule and are unique", () => {
    expect(ROSTER.every((r) => /^[a-z0-9_]{3,20}$/.test(r.handle) && r.bio.length <= 160)).toBe(true);
    expect(new Set(ROSTER.map((r) => r.handle)).size).toBe(ROSTER.length);
  });

  test("a persona acts between 08:00 and midnight in its own time zone", () => {
    const at = (h: number) => Date.UTC(2026, 10, 12, h) / 1000;
    expect(isAwake({ utcOffset: 0 }, at(7))).toBe(false);
    expect(isAwake({ utcOffset: 0 }, at(8))).toBe(true);
    expect(isAwake({ utcOffset: 9 }, at(23))).toBe(true); // 08:00 in Tokyo.
    expect(isAwake({ utcOffset: -8 }, at(10))).toBe(false); // 02:00 in California.
    expect(isAwake({ utcOffset: 5.5 }, at(3))).toBe(true); // 08:30 in India.
  });
});

describe("choosing an action", () => {
  test("an empty wallet draws test USDC first, then settled winnings come before new trades", () => {
    expect(nextAction({ style: "momentum" }, state({ usdc: 10n * USDC }), seq(0.5))).toEqual({ kind: "faucet" });
    const settled: Holding = { series: 7, trend: "topic:x", outcome: "up", up: 5n * USDC, down: 0n };
    expect(nextAction({ style: "momentum" }, state({ holdings: [settled] }), seq(0.5))).toEqual({ kind: "redeem", series: 7, up: 5n * USDC, down: 0n });
  });

  test("momentum sides with the day's move, contrarian fades it", () => {
    expect(sideFor("momentum", trend({ change24h: 5 }), seq(0.1))).toBe("up");
    expect(sideFor("momentum", trend({ change24h: -5 }), seq(0.1))).toBe("down");
    expect(sideFor("contrarian", trend({ change24h: 5 }), seq(0.1))).toBe("up");
    expect(sideFor("contrarian", trend({ change24h: 5 }), seq(0.9))).toBe("down");
  });

  test("only feasible actions are picked, with sizes and bounds the contracts accept", () => {
    for (let i = 0; i < 300; i++) {
      const rng = Math.random;
      const s = state({ trends: [trend({ index: 99.5 }), trend({ identifier: "equity:nvda", index: 0.4, change24h: -3, series: null })] });
      const a = nextAction({ style: ROSTER[i % ROSTER.length]!.style }, s, rng);
      expect(a).not.toBeNull();
      // Nothing to sell, no perp to close.
      expect(["sell", "perpClose", "redeem", "faucet"]).not.toContain(a!.kind);
      if (a!.kind === "buy") {
        expect(a!.series).toBe(45);
        expect(a!.amount >= 2n * USDC && a!.amount <= 30n * USDC).toBe(true);
      }
      if (a!.kind === "perpOpen") {
        expect(a!.acceptableIndex).toBeGreaterThanOrEqual(0);
        expect(a!.acceptableIndex).toBeLessThanOrEqual(100_000_000);
        expect([10_000, 15_000, 20_000, 30_000]).toContain(a!.leverageBps);
      }
    }
  });

  test("calls stop at three a day, perps at three open, and a perp is held an hour before closing", () => {
    const callsOnly = (s: State) => Array.from({ length: 100 }, () => nextAction({ style: "caller" }, s, Math.random)!.kind);
    expect(callsOnly(state({ callsToday: 3 }))).not.toContain("call");
    const young = { id: 1, trend: "topic:world-cup.2", isLong: true, openedAt: 1_794_400_000 - 600 };
    const full = state({ positions: [young, { ...young, id: 2 }, { ...young, id: 3 }] });
    const kinds = Array.from({ length: 200 }, () => nextAction({ style: "perps" }, full, Math.random)!.kind);
    expect(kinds).not.toContain("perpOpen");
    expect(kinds).not.toContain("perpClose");
    const old = state({ positions: [{ ...young, isLong: false, openedAt: 1_794_400_000 - 7_200 }] });
    const close = Array.from({ length: 200 }, () => nextAction({ style: "perps" }, old, Math.random)).find((a) => a?.kind === "perpClose");
    expect(close).toEqual({ kind: "perpClose", position: { ...young, isLong: false, openedAt: 1_794_400_000 - 7_200 }, acceptableIndex: 100_000_000 });
  });
});

describe("words", () => {
  test("notes and posts fill their numbers, fit the API's limits and use no em dash", () => {
    for (let i = 0; i < 50; i++) {
      const t = trend({ change24h: i % 2 ? 4.25 : -4.25 });
      const note = callNote(t, i % 2 ? "up" : "down", i % 3 ? 86_400 : 604_800, Math.random);
      const post = postBody(t, Math.random, i % 4 ? undefined : { handle: "owenh", agree: i % 8 === 0 });
      for (const text of [note, post]) {
        expect(text).not.toMatch(/[{}]|—/);
        expect(text.length).toBeGreaterThan(10);
      }
      expect(note.length).toBeLessThanOrEqual(280);
      expect(post.length).toBeLessThanOrEqual(500);
    }
    expect(postBody(trend(), seq(0), { handle: "owenh", agree: true })).toContain("@owenh");
  });
});

describe("signing", () => {
  test("messages are the API's own, byte for byte", () => {
    const c = { identifier: "topic:world-cup.2", direction: "up", horizonSec: 86_400, note: "Up by tomorrow.", issuedAt: 1_794_400_000 };
    expect(callMessage(c)).toBe(api.callMessage(c));
    const p = { identifier: "topic:world-cup.2", body: "Index check.", replyTo: null, callId: 12, issuedAt: 1_794_400_000 };
    expect(postMessage(p)).toBe(api.postMessage(p));
    expect(profileMessage({ handle: "mila_k", bio: "Hi.", issuedAt: 1 })).toBe(api.profileMessage({ handle: "mila_k", bio: "Hi.", issuedAt: 1 }));
  });

  test("a caller signs what it sends with its own key", async () => {
    const seed = Buffer.from(ed25519.utils.randomSecretKey()).toString("hex");
    const sent: Array<{ url: string; body: Record<string, string | number> }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init!.body)) });
      return new Response(JSON.stringify({ call: { id: 3 } }), { status: 201 });
    };
    const caller = new Caller(seed, "https://api.example", fakeFetch, () => 1_794_400_000);
    await caller.call({ identifier: "topic:world-cup.2", direction: "down", horizonSec: 86_400, note: "Fading it." });
    const b = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://api.example/v1/calls");
    expect(b.caller).toBe(identityOf(seed));
    const message = api.callMessage({ identifier: String(b.identifier), direction: String(b.direction), horizonSec: Number(b.horizonSec), note: String(b.note), issuedAt: Number(b.issuedAt) });
    expect(ed25519.verify(Buffer.from(String(b.signature), "base64"), new TextEncoder().encode(message), Buffer.from(String(b.caller), "hex"))).toBe(true);
    expect(sign(seed, "x")).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });
});
