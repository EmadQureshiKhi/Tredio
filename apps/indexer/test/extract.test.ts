import { describe, expect, test } from "bun:test";
import { Tracker } from "../src/deployments";
import { blockTime, extractEvents, storable, succeeded } from "../src/extract";
import type { Block } from "../src/neardata";
import { ALICE, BTC_COIN, DEPLOYMENT, ev, scenario, STRANGER, T } from "./fixtures/scenario";
import real from "./fixtures/testnet-276377507.json";

const tracker = new Tracker(DEPLOYMENT);

describe("Tracker", () => {
  test("roles of contracts, coins and user accounts", () => {
    expect(tracker.roleOf("registry.tredio.testnet")).toBe("registry");
    expect(tracker.roleOf("usdc.tredio.testnet")).toBe("usdc");
    expect(tracker.roleOf("accounts.tredio.testnet")).toBe("accounts");
    expect(tracker.roleOf(BTC_COIN)).toBe("coin");
    expect(tracker.roleOf("a.b.coins.tredio.testnet")).toBeNull();
    expect(tracker.roleOf("coins.tredio.testnet.evil.testnet")).toBeNull();
    expect(tracker.roleOf(ALICE)).toBe("account");
    expect(tracker.roleOf("0uabc")).toBeNull();
    expect(tracker.roleOf("tredio-mm.testnet")).toBeNull();
    expect(tracker.graduationReserve).toBe(2_000_000_000n);
  });

  test("user accounts keep only tredio-account events", () => {
    expect(tracker.keeps("account", "tredio-account")).toBe(true);
    expect(tracker.keeps("account", "nep141")).toBe(false);
    expect(tracker.keeps("usdc", "nep141")).toBe(true);
  });
});

describe("extractEvents", () => {
  test("a real testnet block: the outcomes receipt's three events", () => {
    const b = real as unknown as Block;
    const events = extractEvents(b, tracker);
    expect(events.map((e) => e.event)).toEqual(["mt_mint", "mt_mint", "sets_minted"]);
    expect(events.every((e) => e.block_height === 276377507 && e.executor === "outcomes.tredio.testnet")).toBe(true);
    expect(events[0]!.receipt_id).toBe("7oxkLr2zh1ckFYx3Q2M7GDwHZr6QyiSfYpYLnCbvhHC9");
    expect(events[0]!.tx_hash).toBe("8A479jENp25XPgAAJQa4z9WKdpWkUbAZntTqEZGDxWTX");
    expect(events.map((e) => e.idx)).toEqual([0, 1, 2]);
    expect(blockTime(b).toISOString()).toBe("2026-11-05T18:22:19.825Z");
  });

  test("several events in one receipt, in log order after a plain log", () => {
    const events = extractEvents(scenario().get(1000)!, tracker);
    expect(events.map((e) => e.event)).toEqual([
      "trend_created",
      "status_changed",
      "trend_created",
      "status_changed",
      "item_rejected",
      "mark_updated",
      "report_processed",
    ]);
    expect(new Set(events.map((e) => e.receipt_id)).size).toBe(1);
    expect(events.map((e) => e.log_index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events[0]!.block_time).toEqual(new Date(T[1000]! * 1000));
  });

  test("a failed receipt and untracked executors are dropped", () => {
    const blocks = scenario();
    const all = [1000, 1002, 1003, 1004, 1005].flatMap((h) => extractEvents(blocks.get(h)!, tracker));
    expect(all.some((e) => JSON.stringify(e.data).includes("topic:failed"))).toBe(false);
    expect(all.some((e) => e.executor === "someone.testnet" || e.executor === STRANGER)).toBe(false);
    expect(all.filter((e) => e.executor === ALICE).every((e) => e.standard === "tredio-account")).toBe(true);
  });

  test("receipt status", () => {
    expect(succeeded({ SuccessValue: "" })).toBe(true);
    expect(succeeded({ SuccessReceiptId: "abc" })).toBe(true);
    expect(succeeded({ Failure: {} })).toBe(false);
    expect(succeeded("Unknown")).toBe(false);
  });
});

describe("hostile events", () => {
  test("strings Postgres cannot store drop the event, not the block", () => {
    const b = scenario().get(1002)!;
    const logs = b.shards[1]!.receipt_execution_outcomes[0]!.execution_outcome.outcome.logs;
    logs.push(
      ev("tredio-account", "session_added", { public_key: "k", label: "nul\u0000", scope: {}, expires_at: 1, daily_limit: "1", gas_key: false }),
      ev("tredio-account", "frozen", { frozen: true, ["\ud800"]: 1 }),
    );
    const events = extractEvents(b, tracker).filter((e) => e.executor === ALICE);
    expect(events.map((e) => e.event)).toEqual(["owner_executed", "session_added"]);
    expect(storable({ a: ["ok", { b: "😀" }] })).toBe(true);
    expect(storable(["\udc00x"])).toBe(false);
  });
});
