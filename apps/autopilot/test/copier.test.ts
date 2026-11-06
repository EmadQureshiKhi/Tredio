import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FollowSettings } from "@tredio/autopilot";
import { holdingsOf } from "../src/copier";
import type { ExecutorDb } from "../src/db";
import { T, TEST_DATABASE_URL, testDb } from "./fakes";
import { audits, LEADER, positions, reset, USER, type World, world } from "./world";

const maybe = TEST_DATABASE_URL ? describe : describe.skip;

const settings: FollowSettings = { mode: "ratio", ratio: 0.1, fixedMarginUsdc: 0, maxMarginUsdc: 50, maxLeverage: 3, maxDailyLossUsdc: 20, maxSlippagePct: 0.3, maxOpenLossUsdc: 5 };

let db: ExecutorDb;
let drop: () => Promise<void>;
let w: World;
let followId: number;

async function follow(s: FollowSettings = settings): Promise<number> {
  const rows = await db.sql<{ id: string }[]>`INSERT INTO follows (follower, leader, settings) VALUES (${USER}, ${LEADER}, ${db.sql.json(s as never)}) RETURNING id`;
  return Number(rows[0]!.id);
}

const skipped = async () => (await audits(db, "copy_skipped")).map((d) => String(d.reason));
const followRow = async () => (await db.sql<{ status: string; status_reason: string | null; closing_out: boolean }[]>`SELECT status, status_reason, closing_out FROM follows WHERE id = ${followId}`)[0]!;

/** The leader opens 0.01 BTC long at 10x, filled at 76,000 (mainnet). */
const leaderOpens = () => w.leaders.hold(LEADER, "BTC", { side: "long", size: 0.01, marginUsdc: 76, entryPrice: 76_000 });

describe("leader snapshots", () => {
  test("positions become holdings by market, with their side, margin and entry", () => {
    const state = { accountValue: 0, withdrawable: 0, totalMarginUsed: 0, time: 0, positions: [{ coin: "ETH", szi: -2, entryPx: 2_250, positionValue: 0, unrealizedPnl: 0, marginUsed: 450, leverage: 10, liquidationPx: null }] };
    expect(holdingsOf(state)).toEqual(new Map([["ETH", { side: "short", size: 2, marginUsdc: 450, entryPrice: 2_250 }]]));
  });
});

maybe("copy-trading", () => {
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  afterAll(async () => drop());
  beforeEach(async () => {
    await reset(db);
    w = await world(db);
    await w.grant(w.user);
    followId = await follow();
  });

  test("records a leader's first snapshot, then mirrors an opening, a reduction and a close within the follow's caps", async () => {
    await w.tick(T);
    expect(w.exchange.posted).toHaveLength(0);
    expect((await db.sql`SELECT market FROM leader_holdings WHERE leader = ${LEADER}`).length).toBe(3);

    leaderOpens();
    await w.tick(T + 15);
    // 10x is held to the follow's 3x; a tenth of the leader's size at 3x is 25.33 USDC of margin.
    expect(w.user.calls[0]).toMatchObject({ hl_leverage: { leverage: 3, is_cross: false } });
    expect(w.exchange.posted[1]!.action).toMatchObject({ orders: [{ b: true, p: "76228", s: "0.001", r: false }] });
    let [p] = await positions(db, { followId });
    expect(p).toMatchObject({ status: "open", side: "long", size: 0.001, entry_price: 76_000, leverage: 3 });

    w.leaders.hold(LEADER, "BTC", { side: "long", size: 0.005, marginUsdc: 38, entryPrice: 76_000 });
    await w.tick(T + 30);
    [p] = await positions(db, { followId });
    expect(p).toMatchObject({ status: "open", size: 0.0005 });

    w.price("BTC", 76_500);
    w.leaders.hold(LEADER, "BTC", null);
    await w.tick(T + 45);
    [p] = await positions(db, { followId });
    expect(p).toMatchObject({ status: "closed", close_reason: "leader_close", exit_price: 76_500 });
    expect((await audits(db, "leader_trade")).map((d) => (d.change as { kind: string }).kind)).toEqual(["open", "decrease", "close"]);
  });

  test("a copy whose leader left is closed again, the same tick and the next, until it is gone", async () => {
    await w.tick(T);
    leaderOpens();
    await w.tick(T + 15);
    w.leaders.hold(LEADER, "BTC", null);
    // The copied close and the sweep's retry in the same tick both fail.
    w.user.failures.push(new Error("price outside 2% of the mark"), new Error("price outside 2% of the mark"));
    await w.tick(T + 30);
    expect((await positions(db, { followId }))[0]!.status).toBe("open");
    await w.tick(T + 45);
    expect((await positions(db, { followId }))[0]).toMatchObject({ status: "closed", close_reason: "leader_exit" });
  });

  test("a follow at its loss cap is paused and its copies closed out", async () => {
    await w.tick(T);
    leaderOpens();
    await w.tick(T + 15);
    w.price("BTC", 70_000);
    await w.tick(T + 30);
    expect(await followRow()).toMatchObject({ status: "paused", closing_out: true });
    expect((await followRow()).status_reason).toContain("down 6.00 USDC (cap 5.00 USDC)");
    expect((await positions(db, { followId }))[0]).toMatchObject({ status: "closed", close_reason: "loss_cap", exit_price: 70_000 });
    await w.tick(T + 45);
    expect((await followRow()).closing_out).toBe(false);
    // Paused: the leader's next trades are not copied.
    w.leaders.hold(LEADER, "ETH", { side: "short", size: 1, marginUsdc: 226, entryPrice: 2_260 });
    await w.tick(T + 60);
    expect(await positions(db, { followId })).toHaveLength(1);
  });

  test("the kill switch skips copied openings but still copies exits", async () => {
    await w.tick(T);
    leaderOpens();
    await w.tick(T + 15);
    await db.sql`INSERT INTO autopilot_control (key, value) VALUES ('kill', ${db.sql.json({ engaged: true, reason: "drill" } as never)})`;
    w.leaders.hold(LEADER, "ETH", { side: "short", size: 1, marginUsdc: 226, entryPrice: 2_260 });
    w.leaders.hold(LEADER, "BTC", null);
    await w.tick(T + 30);
    expect(await skipped()).toEqual(["Autopilot is halted: drill"]);
    const all = await positions(db, { followId });
    expect(all.map((p) => [p.status, p.close_reason])).toEqual([["closed", "leader_close"]]);
  });

  test("never chases: a copy past the follow's slippage from the leader's fill, or in a market testnet lacks, is skipped", async () => {
    await w.tick(T);
    w.leaders.hold(LEADER, "BTC", { side: "long", size: 0.01, marginUsdc: 74, entryPrice: 74_000 });
    w.leaders.hold(LEADER, "DOGE", { side: "long", size: 1000, marginUsdc: 20, entryPrice: 0.2 });
    await w.tick(T + 15);
    expect(await skipped()).toEqual(["the price moved 2.70% from the leader's fill, past your 0.3% limit", "Hyperliquid testnet does not list DOGE"]);
    expect(w.exchange.posted).toHaveLength(0);
  });
});
