import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Tracker } from "../src/deployments";
import { extractEvents, txComplete, txEvents } from "../src/extract";
import { silentLog } from "../src/log";
import type { Block, ReceiptOutcome } from "../src/neardata";
import { resync } from "../src/resync";
import { readCursor } from "../src/store";
import { parseApiJson, TxApi, type TxRecord } from "../src/txapi";
import { TxIngestor } from "../src/txfeed";
import { fakeTxApi, type Grouping } from "./fixtures/fake-txapi";
import { ALICE, DEPLOYMENT, HEIGHTS, OPENAI_COIN, scenario } from "./fixtures/scenario";
import { commitAll, freshSchema, rows, snapshot, TEST_DATABASE_URL } from "./support";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const testnet = new Tracker({
  network: "testnet",
  root: "tredio.testnet",
  contracts: {
    usdc: "usdc.tredio.testnet",
    registry: "registry.tredio.testnet",
    outcomes: "outcomes.tredio.testnet",
    book: "book.tredio.testnet",
    perps: "perps.tredio.testnet",
    curation: "curation.tredio.testnet",
    coins: "coins.tredio.testnet",
    accounts: "accounts.tredio.testnet",
  },
});

describe("transactions to events", () => {
  const tx = parseApiJson<TxRecord>(fixture("testnet-tx-8Tqnn.json"));
  const blocks = parseApiJson<Record<string, Block>>(fixture("testnet-blocks-276416795-797.json"));

  test("a real testnet transaction gives the same rows as the blocks its receipts ran in", () => {
    const fromBlocks = Object.values(blocks).flatMap((b) => extractEvents(b, testnet).filter((e) => e.tx_hash === tx.transaction.hash));
    const fromTx = txEvents(tx, testnet);
    expect(fromTx.map((e) => `${e.block_height}/${e.executor}/${e.event}`)).toEqual([
      "276416795/usdc.tredio.testnet/ft_transfer",
      "276416797/usdc.tredio.testnet/ft_transfer",
    ]);
    expect(fromTx).toEqual(fromBlocks);
    // The block time keeps its nanoseconds through the string parse.
    expect(fromTx[0]!.block_time.toISOString()).toBe("2026-11-06T00:42:29.315Z");
  });

  test("a failed receipt's logs never count", () => {
    const failed = tx.receipts.find((r) => r.execution_outcome.outcome.executor_id === "book.tredio.testnet")!;
    expect(failed.execution_outcome.outcome.logs.length).toBeGreaterThan(0);
    expect(txEvents(tx, testnet).some((e) => e.executor === "book.tredio.testnet")).toBe(false);
  });

  test("a transaction is complete once every receipt it produced ran", () => {
    expect(txComplete(tx)).toBe(true);
    expect(txComplete({ ...tx, receipts: tx.receipts.slice(0, -1) })).toBe(false);
  });
});

describe("TxApi", () => {
  test("pages an account's transactions and reads block times exactly", async () => {
    const bodies: unknown[] = [];
    const fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.account_id) {
        return new Response(
          body.resume_token
            ? '{"account_txs":[{"transaction_hash":"B","tx_block_height":12}]}'
            : '{"txs_count":2,"account_txs":[{"transaction_hash":"A","tx_block_height":11}],"resume_token":"47244640256"}',
        );
      }
      return new Response('{"blocks":[{"block_height":20,"block_timestamp":"1793925944833983279"}]}');
    }) as unknown as typeof globalThis.fetch;
    const api = new TxApi({ baseUrl: "https://tx.example", rpm: 6000, log: silentLog, fetch });
    const first = await api.accountTxs("book.tredio.testnet", 10, 20);
    expect(first).toEqual({ txs: [{ hash: "A", height: 11 }], resume: "47244640256" });
    expect(await api.accountTxs("book.tredio.testnet", 10, 20, first.resume!)).toEqual({ txs: [{ hash: "B", height: 12 }], resume: null });
    expect(bodies[0]).toEqual({ account_id: "book.tredio.testnet", from_tx_block_height: 10, to_tx_block_height: 20, desc: false, limit: 200 });
    expect((bodies[1] as { resume_token: string }).resume_token).toBe("47244640256");
    expect(await api.blocks(1)).toEqual([{ height: 20, time: new Date(1793925944833) }]);
  });
});

/**
 * How the scenario's receipts form transactions: the owner request is relayed, a perp position
 * spans 1003 to 1005 (still running in between), the oracle's 1004 and 1005 receipts share one
 * finished transaction (its 1005 events wait for their window), the coin buy mints in the
 * factory's transaction; Alice's own session transactions and the coin's transfer and burn touch
 * no core account (slow accounts find them below the cursor).
 */
const RELAYER = "tredio-relayer.testnet";
const C = DEPLOYMENT.contracts;
const has = (r: ReceiptOutcome, s: string) => r.execution_outcome.outcome.logs.some((l) => l.includes(s));
const group: Grouping = (h, r) => {
  const ex = r.execution_outcome.outcome.executor_id;
  if (ex === ALICE && h === 1002) return { tx: "TX-owner", signer: RELAYER };
  if (ex === C.perps && ((h === 1003 && has(r, "margin_added")) || h === 1005)) return { tx: "TX-long", signer: ALICE };
  if (ex === C.registry && (h === 1004 || (h === 1005 && has(r, "settlement_missed")))) return { tx: "TX-oracle", signer: "tredio-oracle.testnet" };
  if (h === 1003 && ((ex === C.coins && has(r, '"trade"')) || ex === OPENAI_COIN)) return { tx: "TX-buy", signer: ALICE };
  return undefined;
};

describe.skipIf(!TEST_DATABASE_URL)("tx feed", () => {
  const blocks = scenario();
  let expected: Record<string, unknown[]>;
  let expectedEvents: unknown[];
  let db: Awaited<ReturnType<typeof freshSchema>>;
  const tracker = new Tracker(DEPLOYMENT);
  const withoutTx = (r: object[]): unknown[] => (r as Array<Record<string, unknown>>).map(({ tx_hash: _, ...rest }) => rest);

  beforeAll(async () => {
    const ref = await freshSchema();
    await commitAll(ref.sql, blocks, HEIGHTS);
    expected = await snapshot(ref.sql);
    expectedEvents = withoutTx(await rows(ref.sql`select * from events order by block_height, idx`));
    await ref.drop();
    db = await freshSchema();
  });
  afterAll(() => db.drop());

  /**
   * Runs the feed while the fake head climbs one block every three cycles from 1003 to 1012, so
   * windows of two blocks catch up with it (and the perp transaction is seen running).
   */
  async function feed(o: { lookback: number; cycles?: number }) {
    let cycles = 0;
    const head = () => Math.min(1012, 1003 + Math.floor(cycles / 3));
    const fake = fakeTxApi(blocks, head, { group, extraHeights: [1006, 1007, 1008, 1009, 1010, 1011, 1012] });
    const stop = new AbortController();
    const api = new TxApi({ baseUrl: "https://tx.example", rpm: 600_000, log: silentLog, signal: stop.signal, fetch: fake.fetch });
    const blocksCall = api.blocks.bind(api);
    api.blocks = async (limit, to) => {
      if (to === undefined) cycles++;
      return blocksCall(limit, to);
    };
    const ing = new TxIngestor({
      sql: db.sql,
      api,
      tracker,
      network: "testnet",
      startBlock: 1000,
      coreAccounts: [...Object.values(C), RELAYER],
      safetyBlocks: 0,
      lookbackBlocks: o.lookback,
      backfillWindow: 2,
      slowPerCycle: 1,
      pollMs: 1,
      pendingMaxBlocks: 100,
      log: silentLog,
      signal: stop.signal,
    });
    const run = ing.run();
    const t0 = Date.now();
    while (cycles < (o.cycles ?? 60) && Date.now() - t0 < 15_000) await Bun.sleep(2);
    stop.abort();
    await run;
    return { status: ing.status, paths: fake.paths, requested: fake.requested };
  }

  test("reaches the head with the same tables and events as the block feed", async () => {
    const { status, paths, requested } = await feed({ lookback: 1 });
    expect(status.height).toBe(1012);
    // The perp transaction (1003 to 1005) was fetched while running, then again once finished: a
    // finished one is never fetched again, and with a one-block lookback no listing names it twice.
    expect(requested.filter((h) => h === "TX-long").length).toBe(2);
    expect(await readCursor(db.sql, "testnet")).toEqual({ height: 1012, blockTime: new Date((1793903705 + 7) * 1000) });
    expect(await snapshot(db.sql)).toEqual(expected);
    expect(withoutTx(await rows(db.sql`select * from events order by block_height, idx`))).toEqual(expectedEvents);
    // Transactions came only from listings: no block was ever fetched.
    expect(paths.every((p) => p === "/v0/blocks" || p === "/v0/account" || p === "/v0/transactions")).toBe(true);
  });

  test("a restart lists again from the lookback and changes nothing", async () => {
    const { status } = await feed({ lookback: 600, cycles: 25 });
    expect(status.eventsProcessed).toBe(0);
    expect(await snapshot(db.sql)).toEqual(expected);
  });

  test("a resynced schema rebuilds the same from events stored by the tx feed", async () => {
    await resync(db.sql, "testnet", 1000, tracker, silentLog, { refetch: false });
    expect(await snapshot(db.sql)).toEqual(expected);
  });
});
