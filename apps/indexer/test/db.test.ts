import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { DERIVED_TABLES, lockSchema, RAW_TABLES, type Sql } from "../src/db";
import { HANDLERS } from "../src/derive";
import { on } from "../src/derive/context";
import { extractEvents } from "../src/extract";
import { Ingestor } from "../src/ingest";
import { silentLog } from "../src/log";
import { Neardata } from "../src/neardata";
import { resync } from "../src/resync";
import { commitBlock, readCursor, rebuild } from "../src/store";
import { fakeNeardata } from "./fixtures/fake-neardata";
import { ALICE, BTC_COIN, DEPLOYMENT, ev, EXPIRY, HEIGHTS, KEEPER, MM, OPENAI_COIN, scenario, SESSION_KEY, T } from "./fixtures/scenario";
import { commitAll, count, freshSchema, rows, snapshot, TEST_DATABASE_URL, tracker } from "./support";

const at = (h: number) => new Date(T[h]! * 1000);
const C = DEPLOYMENT.contracts;
const blocks = scenario();
const EVENTS = HEIGHTS.reduce((n, h) => n + (blocks.get(h) ? extractEvents(blocks.get(h)!, tracker).length : 0), 0);

describe.skipIf(!TEST_DATABASE_URL)("derived tables", () => {
  let db: Awaited<ReturnType<typeof freshSchema>>;
  let sql: Sql;

  beforeAll(async () => {
    db = await freshSchema();
    sql = db.sql;
    expect(await commitAll(sql, blocks, HEIGHTS)).toBe(EVENTS);
  });
  afterAll(() => db.drop());

  test("every table of the schema is raw or derived", async () => {
    const rows = await sql`select table_name from information_schema.tables where table_schema = ${db.schema}`;
    const tables = rows.map((r) => r.table_name as string).sort();
    expect(tables).toEqual([...DERIVED_TABLES, ...RAW_TABLES].sort());
  });

  test("raw events and the cursor", async () => {
    expect(EVENTS).toBe(83);
    expect(await count(sql, "events")).toBe(EVENTS);
    expect(await readCursor(sql, "testnet")).toEqual({ height: 1005, blockTime: at(1005) });
    const [first] = await sql`select * from events order by block_height, idx limit 1`;
    expect(first).toMatchObject({ block_height: "1000", idx: 1, log_index: 1, executor: C.registry, standard: "tredio-registry", event: "trend_created" });
    expect(first!.data).toMatchObject({ id: "topic:openai", index: 40_000_000 });
    expect(await count(sql, "events where data::text like '%topic:failed%'")).toBe(0);
  });

  test("registry: trends, index points, settlements, marks, oracle runs", async () => {
    const trends = await rows(sql`select * from trends order by id`);
    expect(trends).toEqual([
      {
        id: "crypto:btc",
        asset_class: "crypto",
        status: "retired",
        index: "30000000",
        peak_index: "60000000",
        surfacer: null,
        review_hash: null,
        asset: "BTC",
        created_at: at(1000),
        updated_at: at(1004),
        status_since: at(1005),
      },
      {
        id: "topic:openai",
        asset_class: "topic",
        status: "active",
        index: "45000000",
        peak_index: "45000000",
        surfacer: ALICE,
        review_hash: "ab".repeat(32),
        asset: null,
        created_at: at(1000),
        updated_at: at(1004),
        status_since: at(1000),
      },
    ]);
    const points = await rows(sql`select trend, at, index, clamped from index_points order by trend, at`);
    expect(points).toEqual([
      { trend: "crypto:btc", at: at(1000), index: "60000000", clamped: false },
      { trend: "crypto:btc", at: at(1004), index: "30000000", clamped: true },
      { trend: "topic:openai", at: at(1000), index: "40000000", clamped: false },
      { trend: "topic:openai", at: at(1004), index: "45000000", clamped: false },
    ]);
    expect(await rows(sql`select trend, expiry, value, missed, first_observation from settlements order by trend`)).toEqual([
      { trend: "crypto:btc", expiry: new Date((T[1003]! + 900) * 1000), value: null, missed: true, first_observation: at(1005) },
      { trend: "topic:openai", expiry: new Date(EXPIRY * 1000), value: "45000000", missed: false, first_observation: null },
    ]);
    expect(await rows(sql`select * from marks`)).toEqual([{ asset: "BTC", price: "6512345000000", at: at(1000) }]);
    expect(await rows(sql`select run_id, created, updated, marks, rejected, block_height from oracle_runs order by run_id`)).toEqual([
      { run_id: "1", created: 2, updated: 0, marks: 1, rejected: 1, block_height: "1000" },
      { run_id: "2", created: 0, updated: 2, marks: 0, rejected: 0, block_height: "1004" },
    ]);
  });

  test("outcomes: series, supplies and balances agree", async () => {
    const [s] = await sql`select * from series`;
    expect(s).toEqual({
      id: "1",
      trend: "topic:openai",
      window_sec: 900,
      number: 1,
      opened_at: at(1002),
      expiry: new Date(EXPIRY * 1000),
      opening_index: "40000000",
      outcome: "up",
      settlement_index: "45000000",
      settled_at: at(1004),
      up_supply: "3000000",
      down_supply: "8000000",
      backing: "3000000",
    });
    expect(await rows(sql`select account, side, balance from outcome_balances order by account, side`)).toEqual([
      { account: C.book, side: "down", balance: "3000000" },
      { account: C.book, side: "up", balance: "1000000" },
      { account: MM, side: "down", balance: "5000000" },
      { account: MM, side: "up", balance: "2000000" },
    ]);
    const [sums] = await sql`
      select sum(balance) filter (where side = 'up')::text as up, sum(balance) filter (where side = 'down')::text as down
      from outcome_balances where series = 1`;
    expect(sums).toEqual({ up: s!.up_supply, down: s!.down_supply });
  });

  test("outcomes: flows per account and series", async () => {
    const flows = await rows(sql`select account, side, kind, tokens, usdc, fee from outcome_flows order by block_height, receipt_id, log_index, leg`);
    expect(flows).toEqual([
      { account: ALICE, side: "set", kind: "mint", tokens: "10000000", usdc: "-10000000", fee: "0" },
      { account: MM, side: "set", kind: "mint", tokens: "5000000", usdc: "-5000000", fee: "0" },
      { account: MM, side: "up", kind: "fill", tokens: "-2000000", usdc: "1040000", fee: "0" },
      { account: ALICE, side: "up", kind: "swap", tokens: "2000000", usdc: "-1042080", fee: "2080" },
      { account: MM, side: "down", kind: "fill", tokens: "3000000", usdc: "-1200000", fee: "0" },
      { account: ALICE, side: "down", kind: "fill", tokens: "-3000000", usdc: "1197600", fee: "2400" },
      { account: ALICE, side: "up", kind: "winnings", tokens: "-12000000", usdc: "12000000", fee: "0" },
      { account: ALICE, side: "down", kind: "winnings", tokens: "-7000000", usdc: "0", fee: "0" },
      { account: MM, side: "set", kind: "redeem", tokens: "-1000000", usdc: "1000000", fee: "0" },
      { account: MM, side: "set", kind: "payout_failed", tokens: "1000000", usdc: "-1000000", fee: "0" },
    ]);
  });

  test("book: markets, orders, trades, swaps", async () => {
    expect(await rows(sql`select series, side, trend, last_tick, volume_usdc, trades from book_markets order by side desc`)).toEqual([
      { series: "1", side: "up", trend: "topic:openai", last_tick: 520, volume_usdc: "1040000", trades: 1 },
      { series: "1", side: "down", trend: "topic:openai", last_tick: 400, volume_usdc: "1200000", trades: 1 },
    ]);
    expect(await rows(sql`select id, owner, side, dir, tick, size, remaining, status, updated_at from book_orders order by id`)).toEqual([
      { id: "1", owner: MM, side: "up", dir: "sell", tick: 520, size: "3000000", remaining: "1000000", status: "cancelled", updated_at: at(1004) },
      { id: "2", owner: MM, side: "down", dir: "buy", tick: 400, size: "3000000", remaining: "0", status: "filled", updated_at: at(1003) },
    ]);
    expect(await count(sql, "book_trades")).toBe(2);
    expect(await rows(sql`select account, dir, anchored, fair, amount_in, amount_out from book_swaps`)).toEqual([
      { account: ALICE, dir: "buy", anchored: true, fair: "500000", amount_in: "1042080", amount_out: "2000000" },
    ]);
  });

  test("perps: positions through close, liquidation and retirement", async () => {
    const p = await rows(sql`select id, owner, status, margin, exit_index, pnl, funding, fee_close, payout, liquidator, reward, equity, shortfall, closed_at from perp_positions order by id`);
    expect(p).toEqual([
      { id: "1", owner: ALICE, status: "closed", margin: "9970089", exit_index: "45000000", pnl: "3738783", funding: "1", fee_close: "33649", payout: "13675222", liquidator: null, reward: null, equity: null, shortfall: null, closed_at: at(1004) },
      { id: "2", owner: MM, status: "liquidated", margin: "2000000", exit_index: "45000000", pnl: null, funding: null, fee_close: null, payout: "0", liquidator: KEEPER, reward: "0", equity: "-500000", shortfall: "0", closed_at: at(1004) },
      { id: "3", owner: ALICE, status: "settled", margin: "6000000", exit_index: "30000000", pnl: "-3000000", funding: "0", fee_close: "0", payout: "3000000", liquidator: null, reward: null, equity: null, shortfall: null, closed_at: at(1005) },
    ]);
    expect(await rows(sql`select trend, at, cum_long, cum_short, mark from perp_funding order by trend, at`)).toEqual([
      { trend: "crypto:btc", at: at(1005), cum_long: "0", cum_short: "0", mark: "30000000" },
      { trend: "topic:openai", at: at(1003), cum_long: "0", cum_short: "0", mark: "40000000" },
      { trend: "topic:openai", at: at(1004), cum_long: "1200000000000", cum_short: "-1200000000000", mark: "45000000" },
    ]);
  });

  test("coins: curves, the floor ratchet, graduation, trades and holdings", async () => {
    const sold = 294752041000000000000000n;
    const spot = ((2_100_000_000n + 495_550n) * 10n ** 36n) / (10n ** 27n - sold);
    expect(await rows(sql`select trend, coin, stage, virtual_quote, reserve, sold, spot, pool_id, graduated_at from curves order by trend`)).toEqual([
      { trend: "crypto:btc", coin: BTC_COIN, stage: "graduated", virtual_quote: "2000000000", reserve: "0", sold: "0", spot: "2000000000000000000", pool_id: "7", graduated_at: at(1005) },
      { trend: "topic:openai", coin: OPENAI_COIN, stage: "open", virtual_quote: "2100000000", reserve: "495550", sold: sold.toString(), spot: spot.toString(), pool_id: null, graduated_at: null },
    ]);
    expect(await count(sql, "coin_trades")).toBe(2);
    expect(await rows(sql`select coin, account, balance from coin_balances`)).toEqual([{ coin: OPENAI_COIN, account: ALICE, balance: sold.toString() }]);
  });

  test("curation, accounts, sessions and USDC", async () => {
    expect(await rows(sql`select trend, surfacer, source, amount from curation`)).toEqual([{ trend: "topic:openai", surfacer: ALICE, source: C.coins, amount: "1000" }]);
    expect(await rows(sql`select account, amount from curation_claims`)).toEqual([{ account: ALICE, amount: "1000" }]);
    expect(await rows(sql`select * from accounts`)).toEqual([
      {
        account: ALICE,
        owner_key: "p256:23xYz",
        funded: "50000000000000000000000",
        created_at: at(1002),
        frozen: true,
        code_hash: "J1GvtY5xj7QuNwmdDFM56EYxmTvwp1wHqkPZjY7CNK9x",
        first_seen: at(1002),
      },
    ]);
    expect(await rows(sql`select account, public_key, label, scope, daily_limit, gas_key, added_at, revoked_at from sessions`)).toEqual([
      {
        account: ALICE,
        public_key: SESSION_KEY,
        label: "This iPhone",
        scope: { outcomes: true, perps: true, hyperliquid: false },
        daily_limit: "250000000",
        gas_key: true,
        added_at: at(1002),
        revoked_at: at(1004),
      },
    ]);
    expect(await rows(sql`select account, action, outflow, spent_today from session_actions`)).toEqual([{ account: ALICE, action: "swap", outflow: "1042080", spent_today: "1042080" }]);
    expect(await rows(sql`select account, kind from hyperliquid_signatures`)).toEqual([{ account: ALICE, kind: "order" }]);
    expect(await rows(sql`select owner, amount, memo from usdc_mints order by owner`)).toEqual([
      { owner: ALICE, amount: "1000000000", memo: "faucet" },
      { owner: MM, amount: "50000000000", memo: "mint" },
    ]);
    expect(await rows(sql`select n, old_owner, new_owner, amount, memo from usdc_transfers where block_height = 1004 order by n`)).toEqual([
      { n: 0, old_owner: C.curation, new_owner: ALICE, amount: "1000", memo: null },
      { n: 1, old_owner: C.outcomes, new_owner: ALICE, amount: "12000000", memo: "winnings" },
    ]);
    expect(await count(sql, "usdc_transfers")).toBe(4);
  });

  test("replaying blocks stores and applies nothing twice", async () => {
    const before = await snapshot(sql);
    expect(await commitAll(sql, blocks, [1004, 1005])).toBe(0);
    expect(await commitAll(sql, blocks, HEIGHTS)).toBe(0);
    expect(await snapshot(sql)).toEqual(before);
    expect(await count(sql, "events")).toBe(EVENTS);
  });

  test("a rebuild from events reproduces every derived table", async () => {
    const before = await snapshot(sql);
    const r = await rebuild(sql, tracker, silentLog, 2);
    expect(r).toEqual({ events: EVENTS, skipped: 0 });
    expect(await snapshot(sql)).toEqual(before);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("ingest loop and resync", () => {
  let db: Awaited<ReturnType<typeof freshSchema>>;
  let expected: Record<string, unknown[]>;

  beforeAll(async () => {
    const ref = await freshSchema();
    await commitAll(ref.sql, blocks, HEIGHTS);
    expected = await snapshot(ref.sql);
    await ref.drop();
    db = await freshSchema();
  });
  afterAll(() => db.drop());

  /** Runs the real loop against the fake neardata until it reaches `until`, then stops it. */
  async function ingest(until: number) {
    const stop = new AbortController();
    const fake = fakeNeardata(blocks, () => 1005);
    const neardata = new Neardata({ baseUrl: "https://testnet.neardata.example", rpm: 60_000, log: silentLog, signal: stop.signal, fetch: fake.fetch });
    const ing = new Ingestor({ sql: db.sql, neardata, tracker, network: "testnet", startBlock: 1000, concurrency: 3, pollMs: 5, log: silentLog, signal: stop.signal });
    const run = ing.run();
    const t0 = Date.now();
    while (ing.status.height < until && Date.now() - t0 < 10_000) await Bun.sleep(5);
    await Bun.sleep(30); // it now waits on the future height 1006
    stop.abort();
    await run;
    return { status: ing.status, paths: fake.paths };
  }

  test("ingests from the start block through a skipped height to the head, then waits", async () => {
    const { status, paths } = await ingest(1005);
    expect(status.height).toBe(1005);
    expect(status.eventsProcessed).toBe(EVENTS);
    expect(paths).toContain("/v0/block/1001");
    expect(paths.filter((p) => p === "/v0/block/1006").length).toBeGreaterThan(0);
    expect(await readCursor(db.sql, "testnet")).toEqual({ height: 1005, blockTime: at(1005) });
    expect(await snapshot(db.sql)).toEqual(expected);
  });

  test("a restart resumes after the cursor and adds nothing", async () => {
    const { status, paths } = await ingest(1005);
    expect(status.eventsProcessed).toBe(0);
    expect(paths.some((p) => p === "/v0/block/1005")).toBe(false);
    expect(await snapshot(db.sql)).toEqual(expected);
  });

  test("resync rebuilds without refetching", async () => {
    await db.sql`update trends set index = 1`;
    await db.sql`delete from outcome_balances`;
    expect(await resync(db.sql, "testnet", 1000, tracker, silentLog, { refetch: false })).toEqual({ events: EVENTS, skipped: 0 });
    expect(await snapshot(db.sql)).toEqual(expected);
    expect((await readCursor(db.sql, "testnet"))?.height).toBe(1005);
  });

  test("resync --from clears the tail, and ingesting again restores it", async () => {
    await resync(db.sql, "testnet", 1000, tracker, silentLog, { refetch: true, from: 1003 });
    expect(await readCursor(db.sql, "testnet")).toEqual({ height: 1002, blockTime: null });
    expect(await count(db.sql, "events where block_height >= 1003")).toBe(0);
    expect(await count(db.sql, "series")).toBe(1);
    expect(await count(db.sql, "outcome_balances")).toBe(0);
    await ingest(1005);
    expect(await snapshot(db.sql)).toEqual(expected);
  });

  test("resync --refetch clears events and the cursor", async () => {
    await resync(db.sql, "testnet", 1000, tracker, silentLog, { refetch: true });
    expect(await count(db.sql, "events")).toBe(0);
    expect(await readCursor(db.sql, "testnet")).toBeNull();
    for (const t of DERIVED_TABLES) expect(await count(db.sql, t)).toBe(0);
    const { status } = await ingest(1005);
    expect(status.eventsProcessed).toBe(EVENTS);
    expect(await snapshot(db.sql)).toEqual(expected);
  });

  test("one process at a time per schema", async () => {
    const release = await lockSchema(db.sql, db.schema);
    expect(release).not.toBeNull();
    expect(await lockSchema(db.sql, db.schema)).toBeNull();
    await release!();
    const again = await lockSchema(db.sql, db.schema);
    expect(again).not.toBeNull();
    await again!();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("bad events never stop a block", () => {
  let db: Awaited<ReturnType<typeof freshSchema>>;
  beforeAll(async () => {
    db = await freshSchema();
  });
  afterAll(() => db.drop());

  const blockWith = (height: number, logs: string[]) => {
    const t = T[1000]! + height;
    return {
      block: { header: { height, timestamp: t * 1e9, timestamp_nanosec: `${t}000000000`, hash: `H${height}` } },
      shards: [
        {
          shard_id: 0,
          receipt_execution_outcomes: [
            {
              execution_outcome: { id: `X${height}`, outcome: { executor_id: ALICE, logs, status: { SuccessValue: "" } } },
              receipt: { receipt_id: `X${height}`, receiver_id: ALICE, predecessor_id: ALICE },
              tx_hash: `TX${height}`,
            },
          ],
        },
      ],
    };
  };

  test("a shape the schema refuses is kept raw and skipped", async () => {
    const b = blockWith(2000, [
      ev("tredio-account", "session_added", { public_key: "k1", label: "far", scope: { outcomes: true, perps: false, hyperliquid: false }, expires_at: 1e300, daily_limit: "1", gas_key: false }),
      ev("tredio-account", "frozen", { frozen: true }),
    ]);
    const stored = await commitBlock(db.sql, "testnet", { height: 2000, blockTime: at(1000) }, extractEvents(b, tracker), tracker, silentLog);
    expect(stored).toBe(2);
    expect(await count(db.sql, "sessions")).toBe(0);
    expect(await rows(db.sql`select account, frozen from accounts`)).toEqual([{ account: ALICE, frozen: true }]);
  });

  test("a handler that fails is skipped once the block retries in isolation", async () => {
    const handlers = HANDLERS.account["tredio-account"]!;
    handlers.boom = on(z.unknown(), async ({ tx }) => {
      await tx`select 1 / 0`;
    });
    try {
      const b = blockWith(2001, [ev("tredio-account", "boom", {}), ev("tredio-account", "upgraded", { code_hash: "abc" })]);
      const events = extractEvents(b, tracker);
      const cursor = { height: 2001, blockTime: at(1000) };
      await expect(commitBlock(db.sql, "testnet", cursor, events, tracker, silentLog)).rejects.toThrow(/division by zero/);
      expect(await count(db.sql, "events where block_height = 2001")).toBe(0);
      expect(await commitBlock(db.sql, "testnet", cursor, events, tracker, silentLog, true)).toBe(2);
      expect(await rows(db.sql`select code_hash from accounts`)).toEqual([{ code_hash: "abc" }]);
      expect((await readCursor(db.sql, "testnet"))?.height).toBe(2001);
    } finally {
      delete handlers.boom;
    }
  });
});
