import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { epochOf, type FollowSettings, sealSignal, type Signal, signalCommitment, signalLeader, viewingKey } from "@tredio/autopilot";
import { holdingsOf } from "../src/copier";
import type { ExecutorDb } from "../src/db";
import { signalLeaders, signalState } from "../src/signals";
import { T, TEST_DATABASE_URL, testDb } from "./fakes";
import { audits, positions, reset, USER, type World, world } from "./world";

const maybe = TEST_DATABASE_URL ? describe : describe.skip;

const IDENTITY = "c".repeat(64);
const LEADER = signalLeader(IDENTITY);
const SECRET = new Uint8Array(32).fill(9);
const settings: FollowSettings = { mode: "ratio", ratio: 0.1, fixedMarginUsdc: 0, maxMarginUsdc: 50, maxLeverage: 3, maxDailyLossUsdc: 20, maxSlippagePct: 0.3, maxOpenLossUsdc: 5 };
const opening = (over: Partial<Signal> = {}): Signal => ({ leader: IDENTITY, kind: "open", market: "BTC", side: "long", marginUsdc: 100, leverage: 5, note: "", issuedAt: T + 5, price: 76_000, ...over });

describe("signal positions", () => {
  test("signals become an account state the copier reads like a trader's", () => {
    const state = signalState([opening(), opening({ market: "ETH", side: "short", marginUsdc: 50, leverage: 2, price: 2_500, issuedAt: T + 6 })], T * 1000);
    expect(holdingsOf(state)).toEqual(
      new Map([
        ["BTC", { side: "long", size: 500 / 76_000, marginUsdc: 100, entryPrice: 76_000 }],
        ["ETH", { side: "short", size: 100 / 2_500, marginUsdc: 50, entryPrice: 2_500 }],
      ]),
    );
    expect(state.positions.find((p) => p.coin === "BTC")?.leverage).toBeCloseTo(5, 9);
  });
});

maybe("copying a signal channel", () => {
  let db: ExecutorDb;
  let drop: () => Promise<void>;
  let w: World;
  let followId: number;

  /** Stores a signal as the API does: sealed under its week's key, with its commitment as the associated data. */
  async function publish(s: Signal, tamper = false): Promise<void> {
    const commitment = await signalCommitment(IDENTITY, s);
    const epoch = epochOf(s.issuedAt);
    const box = await sealSignal(await viewingKey(SECRET, IDENTITY, tamper ? epoch + 1 : epoch), s, commitment);
    await db.sql`
      INSERT INTO signals (leader, commitment, signature, epoch, iv, ciphertext, issued_at, committed_at, commit_tx, reveal_at)
      VALUES (${IDENTITY}, ${commitment}, 'sig', ${epoch}, ${box.iv}, ${box.ciphertext}, ${s.issuedAt}, ${s.issuedAt}, ${`tx-${commitment.slice(0, 8)}`}, ${s.issuedAt + 3600})`;
  }

  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  afterAll(async () => drop());
  beforeEach(async () => {
    await reset(db);
    await db.sql`TRUNCATE signal_access, signals, signal_channels, callers RESTART IDENTITY CASCADE`;
    await db.sql`INSERT INTO callers (address, handle, linked_account) VALUES (${IDENTITY}, 'chartist', '0uleader')`;
    await db.sql`INSERT INTO signal_channels (leader, price_usdc, period_days, reveal_delay_sec) VALUES (${IDENTITY}, 5000000, 30, 3600)`;
    w = await world(db, (fake) => signalLeaders({ sql: db.sql, secret: SECRET, network: "testnet", others: fake, now: () => (T + 60) * 1000 }));
    await w.grant(w.user);
    const rows = await db.sql<{ id: string }[]>`INSERT INTO follows (follower, leader, settings) VALUES (${USER}, ${LEADER}, ${db.sql.json(settings as never)}) RETURNING id`;
    followId = Number(rows[0]!.id);
  });

  test("an opening signal is copied within the follow's caps and a closing one closes the copy", async () => {
    await w.tick(T);
    expect(w.exchange.posted).toHaveLength(0);

    await publish(opening());
    await w.tick(T + 15);
    let [p] = await positions(db, { followId });
    // A tenth of the signal's size (500 USDC at 76,000), rounded down to BTC's 5 decimals, at the follow's 3x at most.
    expect(p).toMatchObject({ status: "open", side: "long", size: 0.00065, leverage: 3 });

    await publish(opening({ kind: "close", marginUsdc: null, leverage: null, issuedAt: T + 20 }));
    await w.tick(T + 30);
    [p] = await positions(db, { followId });
    expect(p).toMatchObject({ status: "closed", close_reason: "leader_close" });
    expect((await audits(db, "leader_trade")).map((d) => (d.change as { kind: string }).kind)).toEqual(["open", "close"]);
  });

  test("a signal that does not open with its week's key is left out", async () => {
    await w.tick(T);
    await publish(opening(), true);
    await w.tick(T + 15);
    expect(await positions(db, { followId })).toHaveLength(0);
  });

  test("other leaders still come from the trader source", async () => {
    const source = signalLeaders({ sql: db.sql, secret: SECRET, network: "testnet", others: w.leaders.source() });
    w.leaders.hold("0x00000000000000000000000000000000000000b2", "ETH", { side: "short", size: 1, marginUsdc: 226, entryPrice: 2_260 });
    const { network, state } = await source.state("0x00000000000000000000000000000000000000b2");
    expect(network).toBe("mainnet");
    expect(state.positions).toHaveLength(1);
  });
});
