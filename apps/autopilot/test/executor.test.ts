import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { autopilotMarketProblem, seal } from "@tredio/autopilot";
import type { ExecutorDb } from "../src/db";
import { FakeAccount, market, T, TEST_DATABASE_URL, testDb } from "./fakes";
import { audits, BOT, events, orders, positions, reset, rule, USER, type World, world } from "./world";

const maybe = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) console.warn("executor tests skipped: set TEST_DATABASE_URL to a Postgres database the tests may write (each run uses its own schema)");

let db: ExecutorDb;
let drop: () => Promise<void>;
let w: World;

maybe("rules", () => {
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  afterAll(async () => drop());
  beforeEach(async () => {
    await reset(db);
    w = await world(db);
    await w.grant(w.user);
  });

  test("opens on the signal through the account's session, holds, then takes profit with PnL net of both fees", async () => {
    const id = await w.addRule();
    await w.tick(T);
    expect(w.exchange.posted.map((p) => p.action.type)).toEqual(["updateLeverage", "order"]);
    expect(w.exchange.posted.every((p) => p.user === w.user.address)).toBe(true);
    const [open] = await orders(db);
    expect(open).toMatchObject({ intent: `rule:${id}:open:1`, action: "open", status: "filled", size: 0.00052, worst_price: 76_380, tx_hash: "tx2", attempts: 1 });
    // The recorded nonce is the one Hyperliquid saw.
    expect(Number(open!.request_id)).toBe(w.exchange.posted[1]!.nonce);
    const [p] = await positions(db, { ruleId: id });
    expect(p).toMatchObject({ status: "open", side: "long", size: 0.00052, entry_price: 76_000, leverage: 2 });
    expect(p!.margin_usdc).toBeCloseTo((0.00052 * 76_000) / 2);

    w.price("BTC", 77_000);
    await w.tick(T + 60);
    expect(w.exchange.posted).toHaveLength(2);

    w.price("BTC", 79_100);
    await w.tick(T + 120);
    const close = w.exchange.posted[2]!;
    expect(close.action).toMatchObject({ type: "order", orders: [{ a: 3, b: false, r: true, s: "0.00052", t: { limit: { tif: "Ioc" } } }] });
    const [closed] = await positions(db, { ruleId: id });
    const fees = (0.00052 * 76_000 + 0.00052 * 79_100) * 0.00045;
    expect(closed).toMatchObject({ status: "closed", exit_price: 79_100, close_reason: "take_profit" });
    expect(closed!.pnl_usdc!).toBeCloseTo(3_100 * 0.00052 - fees, 6);
    expect(closed!.fees_usdc).toBeCloseTo(fees, 6);
    expect(await events(db, { ruleId: id })).toEqual(["entry_signal", "order_sent", "order_filled", "waiting", "exit_signal", "order_sent", "order_filled"]);
  });

  test("the kill switch opens nothing and closes what Autopilot holds", async () => {
    const id = await w.addRule();
    await db.sql`INSERT INTO autopilot_control (key, value) VALUES ('kill', ${db.sql.json({ engaged: true, reason: "drill" } as never)})`;
    await w.tick(T);
    expect(w.exchange.posted).toHaveLength(0);
    expect(await audits(db, "waiting")).toEqual([{ reason: "Autopilot is halted: drill" }]);
    expect(w.executor.status.kill).toEqual({ engaged: true, reason: "drill" });

    await db.sql`UPDATE autopilot_control SET value = ${db.sql.json({ engaged: false } as never)} WHERE key = 'kill'`;
    await w.tick(T + 15);
    expect((await positions(db, { ruleId: id }))[0]!.status).toBe("open");

    await db.sql`UPDATE autopilot_control SET value = ${db.sql.json({ engaged: true, reason: "drill" } as never)} WHERE key = 'kill'`;
    await w.tick(T + 30);
    expect((await positions(db, { ruleId: id }))[0]).toMatchObject({ status: "closed", close_reason: "kill" });
  });

  test("a paused rule manages its position to an exit; the owner's stop closes it now", async () => {
    const id = await w.addRule();
    await w.tick(T);
    await db.sql`UPDATE autopilot_rules SET status = 'paused' WHERE id = ${id}`;
    await w.tick(T + 15);
    expect((await positions(db, { ruleId: id }))[0]!.status).toBe("open");
    await db.sql`UPDATE autopilot_rules SET status = 'stopped' WHERE id = ${id}`;
    await w.tick(T + 30);
    expect((await positions(db, { ruleId: id }))[0]).toMatchObject({ status: "closed", close_reason: "kill" });
    // Nothing reopens for a rule that is not enabled.
    await w.tick(T + 45);
    expect(await positions(db, { ruleId: id })).toHaveLength(1);
  });

  test("daily loss and cooldown come from the engine's state", async () => {
    const id = await w.addRule({ ...rule, limits: { ...rule.limits, maxDailyLossUsdc: 1, cooldownMin: 30 } });
    await w.tick(T);
    w.price("BTC", 72_000);
    await w.tick(T + 15);
    expect((await positions(db, { ruleId: id }))[0]).toMatchObject({ status: "closed", close_reason: "stop" });
    w.price("BTC", 72_100);
    await w.tick(T + 30);
    expect(await audits(db, "waiting")).toContainEqual({ reason: "daily loss limit reached" });
    await db.sql`UPDATE autopilot_positions SET pnl_usdc = 0 WHERE rule_id = ${id}`;
    await w.tick(T + 45);
    expect(await audits(db, "waiting")).toContainEqual({ reason: "cooling down after the last trade" });
    // Attention jumps again; the cooldown has run out.
    await db.sql`INSERT INTO index_points (trend_id, observed_at, points) VALUES ('crypto:btc', ${T + 1700}, 80)`;
    await w.tick(T + 15 + 1800);
    expect(await positions(db, { ruleId: id })).toHaveLength(2);
  });

  test("openings wait for the account's price guard and for margin on Hyperliquid", async () => {
    await w.addRule();
    w.registry.set("BTC", 76_000, T - 101);
    await w.tick(T);
    w.registry.set("BTC", 78_000);
    await w.tick(T + 15);
    w.registry.set("BTC", 76_000);
    w.exchange.fund(w.user.address, 5);
    await w.tick(T + 30);
    expect(w.exchange.posted).toHaveLength(0);
    const reasons = (await audits(db, "waiting")).map((d) => String(d.reason));
    expect(reasons[0]).toContain("BTC mark is 101s old");
    expect(reasons[1]).toContain("more than 2% from Tredio's BTC mark");
    expect(reasons[2]).toContain("Hyperliquid balance (5.00 USDC available)");
  });

  test("the bot trades from its own account; openings stay within the session's 10x, with the rule's margin", async () => {
    const id = await w.addRule({ ...rule, size: { marginUsdc: 10, leverage: 15 }, exits: { ...rule.exits, stopLossPct: 5 }, limits: { ...rule.limits, maxPositionUsdc: 150 } }, { owner: BOT, route: "api" });
    await w.tick(T);
    expect(w.exchange.posted.every((p) => p.user === w.bot.address)).toBe(true);
    expect(w.bot.calls[0]).toMatchObject({ hl_leverage: { leverage: 10, is_cross: false } });
    const [p] = await positions(db, { ruleId: id });
    // 150 USDC at 15x is 10 USDC of margin; at 10x the same margin buys 100 USDC.
    expect(p).toMatchObject({ status: "open", leverage: 10, size: 0.00131 });
    expect(p!.margin_usdc).toBeCloseTo((0.00131 * 76_000) / 10);
  });

  test("an order cut off before Hyperliquid answered goes out again with the same nonce and runs once", async () => {
    const id = await w.addRule();
    w.cutOrders(3, false);
    await w.tick(T);
    let [o] = await orders(db);
    expect(o).toMatchObject({ status: "sent", attempts: 1, tx_hash: "tx2" });
    expect((await positions(db, { ruleId: id }))[0]!.status).toBe("opening");
    await w.tick(T + 15);
    [o] = await orders(db);
    expect(o).toMatchObject({ status: "filled", attempts: 2 });
    const posts = w.exchange.posted.filter((p) => p.action.type === "order");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.nonce).toBe(Number(o!.request_id));
    expect((await positions(db, { ruleId: id }))[0]!.status).toBe("open");
  });

  test("an order Hyperliquid ran whose answer was lost is settled from the account's fills", async () => {
    const id = await w.addRule();
    w.cutOrders(1, true);
    await w.tick(T);
    expect((await orders(db))[0]).toMatchObject({ status: "filled" });
    expect((await positions(db, { ruleId: id }))[0]).toMatchObject({ status: "open", size: 0.00052, entry_price: 76_000 });
    expect((await w.exchange.accountState(w.user.address)).positions).toHaveLength(1);
  });

  test("a signed order whose session is revoked before the answer is settled from the account's fills", async () => {
    const id = await w.addRule();
    w.cutOrders(3, true);
    await w.tick(T);
    expect((await orders(db))[0]).toMatchObject({ status: "sent" });
    w.user.session_ = null;
    await w.tick(T + 15);
    expect((await orders(db))[0]).toMatchObject({ status: "filled" });
    expect((await positions(db, { ruleId: id }))[0]).toMatchObject({ status: "open", size: 0.00052 });
    expect(w.exchange.posted.filter((p) => p.action.type === "order").every((p) => p.nonce === w.exchange.posted[1]!.nonce)).toBe(true);
  });

  test("reconciles with Hyperliquid: a liquidation closes the position with Hyperliquid's own numbers", async () => {
    const id = await w.addRule();
    await w.tick(T);
    w.price("BTC", 74_000);
    w.exchange.now = () => (T + 10) * 1000;
    w.exchange.liquidate(w.user.address, "BTC");
    await w.tick(T + 15);
    const [p] = await positions(db, { ruleId: id });
    const margin = (0.00052 * 76_000) / 2;
    expect(p).toMatchObject({ status: "closed", close_reason: "liquidated on Hyperliquid", exit_price: 74_000 });
    expect(p!.pnl_usdc!).toBeCloseTo(-margin - 0.00052 * 76_000 * 0.00045, 6);
    expect(await events(db, { ruleId: id })).toContain("position_closed_externally");
  });

  test("a position closed by hand without fills to read is closed at the mark, with an estimate", async () => {
    const id = await w.addRule();
    await w.tick(T);
    w.price("BTC", 77_000);
    w.exchange.books.get(w.user.address)!.delete("BTC");
    await w.tick(T + 15);
    const [p] = await positions(db, { ruleId: id });
    expect(p).toMatchObject({ status: "closed", close_reason: "closed outside Autopilot (liquidated or closed by hand)", exit_price: 77_000 });
    expect(p!.pnl_usdc!).toBeCloseTo(1_000 * 0.00052 - 0.00052 * 76_000 * 0.00045, 6);
  });

  test("a grant whose session is gone on chain ends, and its rules pause", async () => {
    const id = await w.addRule();
    w.user.session_ = null;
    await w.tick(T);
    expect((await db.sql<{ status: string }[]>`SELECT status FROM autopilot_grants WHERE owner = ${USER}`)[0]!.status).toBe("revoked");
    const [r] = await db.sql<{ status: string; status_reason: string }[]>`SELECT status, status_reason FROM autopilot_rules WHERE id = ${id}`;
    expect(r).toEqual({ status: "paused", status_reason: "no active Autopilot grant for the account" });
    expect(w.exchange.posted).toHaveLength(0);
  });

  test("a waiting key takes over once the account has added it on chain", async () => {
    const id = await w.addRule();
    const next = w.add(new FakeAccount(USER, "autopilot", undefined, w.user.hlSecret));
    const box = await seal(next.key.secretKey, w.sealPublic, { owner: USER, sessionKey: next.key.publicKey });
    await db.sql`UPDATE autopilot_grants SET next_session_key = ${next.key.publicKey}, next_sealed_key = ${box} WHERE owner = ${USER}`;
    await w.tick(T);
    const [g] = await db.sql<{ session_key: string; next_session_key: string | null }[]>`SELECT session_key, next_session_key FROM autopilot_grants WHERE owner = ${USER}`;
    expect(g).toEqual({ session_key: next.key.publicKey, next_session_key: null });
    expect(next.calls).toHaveLength(2);
    expect(w.user.calls).toHaveLength(0);
    expect((await positions(db, { ruleId: id }))[0]!.status).toBe("open");
  });

  test("a grant sealed for another account does not open", async () => {
    const id = await w.addRule();
    const box = await seal(w.user.key.secretKey, w.sealPublic, { owner: "someone-else", sessionKey: w.user.key.publicKey });
    await db.sql`UPDATE autopilot_grants SET sealed_key = ${box} WHERE owner = ${USER}`;
    await w.tick(T);
    expect(await audits(db, "grant_unusable")).toHaveLength(1);
    expect((await db.sql<{ status: string }[]>`SELECT status FROM autopilot_rules WHERE id = ${id}`)[0]!.status).toBe("paused");
  });

  test("pauses a rule after three failed orders in a row", async () => {
    const id = await w.addRule();
    for (let i = 0; i < 3; i++) w.user.failures.push(new Error("price outside 2% of the mark"));
    // The leverage change is the first session call each time; it fails before the order is signed.
    for (let i = 0; i < 3; i++) await w.tick(T + i * 15);
    expect((await orders(db)).map((o) => o.status)).toEqual(["failed", "failed", "failed"]);
    const [r] = await db.sql<{ status: string; status_reason: string }[]>`SELECT status, status_reason FROM autopilot_rules WHERE id = ${id}`;
    expect(r!.status).toBe("paused");
    expect(r!.status_reason).toBe("3 orders failed in a row: price outside 2% of the mark");
    expect((await positions(db, { ruleId: id })).map((p) => p.status)).toEqual(["failed", "failed", "failed"]);
  });

  test("a rule saved on a market outside Autopilot's pauses rather than waiting for a mark that may never come", async () => {
    // Testnet lists ZEC and Tredio has a mark for it now (a live ZEC trend), but the oracle does not keep marking it.
    w.exchange.markets.push(market("ZEC", 9, 2, 140, 10));
    w.registry.set("ZEC", 140);
    const id = await w.addRule({ ...rule, market: "ZEC", trend: "crypto:btc" });
    await w.tick(T);
    const [r] = await db.sql<{ status: string; status_reason: string }[]>`SELECT status, status_reason FROM autopilot_rules WHERE id = ${id}`;
    expect(r).toEqual({ status: "paused", status_reason: autopilotMarketProblem("ZEC")! });
    expect(w.exchange.posted).toHaveLength(0);
  });

  test("never opens a second position in a market the account already holds", async () => {
    await w.addRule();
    const other = await w.addRule({ ...rule, name: "Another" });
    await w.tick(T);
    expect(await positions(db, { ruleId: other })).toHaveLength(0);
    expect(await audits(db, "waiting")).toContainEqual({ reason: "BTC already has an Autopilot position on this account (rule 1)" });
  });
});
