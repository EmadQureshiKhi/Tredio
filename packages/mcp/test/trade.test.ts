import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Encode, TxError } from "@tredio/chain";
import { type Call, calls, deployment } from "@tredio/contracts";
import { TredioApi } from "../src/api";
import type { ChainViews, TxIndex } from "../src/chain";
import { parsePolicy, SpendGuard, SpendLedger } from "../src/policy";
import { createServer } from "../src/server";
import { callerKey, type Signer, type TxOutcome } from "../src/signers";
import type { TradingDeps } from "../src/trade";

const D = deployment("testnet");
const C = D.contracts;
const K = calls(D);
const NOW = 1_794_200_000;
const TREND = "topic:world-cup.2";
const COIN = "topic-world-cup-2.coins.tredio.testnet";
const AGENT = "agent.testnet";
const SESSION = "0u6xynn46jqv8rwe2r6we26zeakwcsnykzsr3bnxtyt32k5gvsdza0";
const SESSION_KEY = "ed25519:3kAQWMSsbbwBskBpageDpB6j8ePCJ3NKeqxFqGKXT6QG";
const series = { id: 45, trend: TREND, window: 86_400, number: 3, opened_at: NOW - 600, expiry: NOW + 85_800, opening_index: 50_000_000, settlement_index: null, outcome: "open", up_supply: "0", down_supply: "0", backing: "0" };
const position = { id: 7, owner: AGENT, trend: TREND, is_long: true, entry_index: 50_000_000, qty: "200000000000000000", margin: "9990000", entry_funding: "0", opened_at: NOW - 3600 };

/** The contract views the trade tools read; a test changes entries to set the scene. */
const baseViews = (): Record<string, unknown> => ({
  [`${C.registry}.index_of`]: { id: TREND, status: "active", index: 50_940_000, peak_index: 52_000_000, updated_at: NOW - 60, fresh: true, retired_at: null, surfacer: null },
  [`${C.registry}.fair_up`]: "500000",
  [`${C.outcomes}.get_series`]: series,
  [`${C.outcomes}.latest_series`]: series,
  [`${C.outcomes}.mt_balance_of`]: "40000000",
  [`${C.outcomes}.storage_balance_of`]: null,
  [`${C.book}.get_market`]: { series: 45, side: "up", trend: TREND, opening_index: 50_000_000, expiry: series.expiry, last_tick: 500, volume_usdc: "0", trades: 0 },
  [`${C.book}.depth`]: {
    series: 45,
    side: "up",
    asks: [
      { tick: 530, price: "530000", size: "20000000" },
      { tick: 540, price: "540000", size: "20000000" },
    ],
    bids: [
      { tick: 470, price: "470000", size: "20000000" },
      { tick: 460, price: "460000", size: "20000000" },
    ],
    last_tick: 500,
  },
  [`${C.book}.storage_balance_of`]: { total: String(2n * 10n ** 22n), available: String(2n * 10n ** 22n) },
  [`${C.usdc}.ft_balance_of`]: "1000000000",
  [`${C.usdc}.storage_balance_of`]: { total: "1250000000000000000000", available: "0" },
  [`${C.perps}.storage_balance_of`]: { total: String(10n ** 22n), available: String(10n ** 21n) },
  [`${C.perps}.get_market`]: { long_qty: "0", short_qty: "0", cum_long: "0", cum_short: "0", last_time: NOW - 60, last_mark: 50_940_000 },
  [`${C.perps}.open_interest_cap`]: "250000000000",
  [`${C.perps}.positions_of`]: [],
  [`${C.perps}.get_position`]: position,
  [`${C.perps}.position_state`]: { index: 50_940_000, equity: "10178000", pnl: "188000", funding: "0", notional: "10188000", liquidatable: false, liquidation_index: 34_000_000 },
  [`${C.coins}.get_curve`]: { trend: TREND, coin: COIN, stage: "open", peak_at_creation: 50_000_000, created_at: NOW - 600, virtual_quote: "2000000000", reserve: "0", sold: "0", floor_reserve: "0", graduation_liquidity: "0", pool_id: null, grad_coins: "0", grad_quote: "0", grad_minted: false, coins_deposited: false, quote_deposited: false },
  [`${C.coins}.quote_buy`]: { out: "1000000000000000000000000", fee: "20000", spot_after: "2000002000000000000" },
  [`${C.coins}.quote_sell`]: { out: "1980000", fee: "20000", spot_after: "1999998000000000000" },
  [`${C.coins}.spot_price`]: "2000000000000000000",
  [`${COIN}.ft_balance_of`]: "5000000000000000000000000",
  [`${SESSION}.session`]: { label: "agent", scope: { outcomes: true, perps: true, hyperliquid: false }, created_at: NOW - 86_400, expires_at: NOW + 86_400, daily_limit: "100000000", spent: "0", day: Math.floor(NOW / 86_400), gas_key: true },
  [`${SESSION}.frozen`]: false,
  [`${SESSION}.version`]: 2,
});

let views: Record<string, unknown>;
let gasBalance: bigint | null;
const viewCalls: Array<{ key: string; args: unknown }> = [];
const chain: ChainViews = {
  async view<T>(contract: string, method: string, args?: object): Promise<T> {
    const key = `${contract}.${method}`;
    viewCalls.push({ key, args });
    if (!(key in views)) throw new Error(`MethodNotFound: ${key}`);
    return structuredClone(views[key]) as T;
  },
  async rpc<T>(method: string, params: unknown): Promise<T> {
    const p = params as { request_type?: string; account_id?: string };
    if (method === "query" && p.request_type === "view_access_key") {
      if (gasBalance === null) return { permission: { FunctionCall: { receiver_id: p.account_id, method_names: ["session_call"] } } } as T;
      return { permission: { GasKeyFunctionCall: { balance: gasBalance.toString(), num_nonces: 4, receiver_id: p.account_id, method_names: ["session_call"] } } } as T;
    }
    throw new Error(`unexpected rpc ${method}`);
  },
};
const txIndex: TxIndex = {
  // The trade tools never search transactions.
  async *recent() {},
};

const event = (standard: string, name: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event: name, data })}`;
const outcome = (hash: string, logs: string[] = []): TxOutcome => ({ transaction: { hash }, transaction_outcome: { id: hash, outcome: { logs: [] } }, receipts_outcome: [{ outcome: { logs } }] });

/** A signer that records what it is asked to send and answers from a script. */
class FakeSigner implements Signer {
  readonly sent: Call[] = [];
  readonly answers: Array<(call: Call) => TxOutcome> = [];
  constructor(
    readonly kind: "session" | "account",
    readonly account: string,
    readonly publicKey: string,
  ) {}
  async send(call: Call): Promise<TxOutcome> {
    this.sent.push(call);
    const next = this.answers.shift();
    return next ? next(call) : outcome(`Hash${this.sent.length}`);
  }
}

let dir: string;
const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  posted.push({ url, body });
  if (url === "http://api.test/v1/calls") {
    const sig = Buffer.from(String(body.signature), "base64");
    const text = `Tredio call\ntrend: ${body.identifier}\ndirection: ${body.direction}\nhorizon: ${body.horizonSec}\nnote: ${Buffer.from(sha256(new TextEncoder().encode(String(body.note)))).toString("hex")}\nissued: ${body.issuedAt}`;
    if (!ed25519.verify(sig, new TextEncoder().encode(text), Buffer.from(String(body.caller), "hex"))) return Response.json({ error: "bad or expired signature" }, { status: 401 });
    return Response.json({ call: { id: 31, caller: body.caller, identifier: body.identifier, direction: body.direction, horizonSec: body.horizonSec, openingIndex: 50.94, calledAt: NOW, resolvesAt: NOW + Number(body.horizonSec) } }, { status: 201 });
  }
  if (url === "http://relayer.test/v1/sessions/fund") return Response.json({ hash: "FundHash", balance: "500000000000000000000000" });
  if (url === "http://relayer.test/v1/storage/fund") return Response.json({ hash: null, available: "0" });
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

const POLICY = {
  dailyCapUsdc: "20",
  tools: { buy_outcome: { maxUsdc: "10" }, sell_outcome: true, open_perp: { maxUsdc: "15" }, close_perp: true, add_perp_margin: { maxUsdc: "5" }, buy_coin: { maxUsdc: "3" }, sell_coin: true, post_call: true },
};

interface Setup {
  signer?: FakeSigner | null;
  policy?: unknown;
  caller?: TradingDeps["caller"];
  relayerUrl?: string | null;
}
let open: Client[] = [];
async function connect(o: Setup = {}) {
  const guard = new SpendGuard(parsePolicy(o.policy ?? POLICY), new SpendLedger(join(dir, "ledger.json"), () => NOW * 1000));
  const signer = o.signer === undefined ? new FakeSigner("account", AGENT, "ed25519:Agent") : o.signer;
  const trading: TradingDeps = { signer, caller: o.caller ?? null, guard, relayerUrl: o.relayerUrl ?? null, now: () => NOW * 1000 };
  const server = createServer({ api: new TredioApi("http://api.test", fetchStub), chain, txIndex, deployment: D, network: "testnet", trading, fetchImpl: fetchStub });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  open.push(client);
  type R = { structuredContent?: Record<string, any>; isError?: boolean; content: Array<{ text?: string }> };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as R;
  const data = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
    return r.structuredContent!;
  };
  const error = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    expect(r.isError).toBe(true);
    return r.content[0]?.text ?? "";
  };
  return { client, call, data, error, guard, signer: signer as FakeSigner };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tredio-trade-"));
  views = baseViews();
  gasBalance = 313n * 10n ** 21n;
  posted.length = 0;
  viewCalls.length = 0;
});
afterEach(async () => {
  await Promise.all(open.map((c) => c.close()));
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

const swapMsg = (minOut: string) => JSON.stringify({ swap: { series: 45, side: "up", limit_tick: null, min_out: minOut, anchored: true } });
const storageCall = (contract: string, deposit: bigint): Call => ({ receiverId: contract, methodName: "storage_deposit", args: { account_id: AGENT, registration_only: false }, deposit: deposit.toString(), gas: (30n * 10n ** 12n).toString() });

describe("trade tools", () => {
  test("appear only with trading configured, with the signing paths in their descriptions", async () => {
    const { client } = await connect({ caller: callerKey(`ed25519:${base58Encode(new Uint8Array(32).fill(7))}`) });
    const { tools } = await client.listTools();
    const trade = ["add_perp_margin", "buy_coin", "buy_outcome", "close_perp", "get_trading_policy", "open_perp", "post_call", "sell_coin", "sell_outcome"];
    expect(tools.map((t) => t.name).filter((n) => trade.includes(n)).sort()).toEqual(trade);
    for (const name of ["buy_outcome", "sell_outcome", "open_perp", "close_perp"]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.description).toContain("passkey account's session key");
      expect(t.description).toContain("NEAR account's own key");
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(Object.keys(t.inputSchema.properties ?? {})).toContain("confirm");
    }
    for (const name of ["add_perp_margin", "buy_coin", "sell_coin"]) expect(tools.find((x) => x.name === name)!.description).toContain("NEAR account's own key only");
    const without = await connect({ caller: null });
    expect((await without.client.listTools()).tools.some((t) => t.name === "post_call")).toBe(false);
  });

  test("buy_outcome: a dry run quotes the anchored swap and the exact calls, and sends nothing", async () => {
    const { data, signer, guard } = await connect();
    const r = await data("buy_outcome", { trend: TREND, side: "up", usdc: "5" });
    // 5 USDC at 0.530 with the 20 bps taker fee: 9415 lots (9.415 tokens) for 4.999929 USDC; 1% slippage.
    expect(r).toMatchObject({ dryRun: true, ready: true, blocker: null, spendUsdc: "5", signer: { path: "own key of a NEAR account", account: AGENT } });
    expect(r.quote).toMatchObject({ series: 45, side: "up", fairValue: 0.5, worstPriceAllowed: 0.6, usdcIn: "5", tokensOut: "9.415", usdcUsed: "4.999929", minTokensOut: "9.32085", worstPrice: 0.53, fillsCompletely: true, takerFeeBps: 20 });
    // The account is not registered with the outcomes contract yet, so it deposits storage first.
    expect(r.calls).toEqual([storageCall(C.outcomes, 2n * 10n ** 22n), K.book.depositUsdc("5000000", swapMsg("9320850"))]);
    expect(r.policy).toMatchObject({ allowed: true, maxUsdcPerCall: "10", dailyCapUsdc: "20", spentTodayUsdc: "0" });
    expect(signer.sent).toEqual([]);
    expect(guard.ledger.entries()).toEqual([]);
  });

  test("buy_outcome: confirm sends the calls and records the trade in the ledger", async () => {
    const { data, signer, guard } = await connect();
    signer.answers.push(
      () => outcome("StorageHash"),
      () => outcome("SwapHash", [event("tredio-book", "swap", { account: AGENT, series: 45, side: "up", dir: "buy", anchored: true, fair: "500000", amount_in: "4999929", amount_out: "9415000" })]),
    );
    const r = await data("buy_outcome", { series: 45, side: "up", usdc: "5", confirm: true });
    expect(r).toMatchObject({ sent: true, hash: "SwapHash", explorer: "https://testnet.nearblocks.io/txns/SwapHash", setupHashes: ["StorageHash"], spendUsdc: "5" });
    expect(r.result).toEqual({ series: 45, side: "up", usdcSpent: "4.999929", tokensReceived: "9.415", fairValue: 0.5 });
    expect(r.policy).toEqual({ spentTodayUsdc: "5", leftTodayUsdc: "15", dailyCapUsdc: "20" });
    expect(signer.sent).toEqual([storageCall(C.outcomes, 2n * 10n ** 22n), K.book.depositUsdc("5000000", swapMsg("9320850"))]);
    const [entry] = guard.ledger.entries();
    expect(entry).toMatchObject({ tool: "buy_outcome", account: AGENT, signer: "account", usdc: "5", status: "sent", hash: "SwapHash", setupHashes: ["StorageHash"], args: { series: 45, side: "up", usdc: "5", window: "24h", slippageBps: 100 } });
    expect(entry!.args).not.toHaveProperty("confirm");
  });

  test("sell_outcome quotes the bids within the band and moves the tokens to the book", async () => {
    views[`${C.outcomes}.storage_balance_of`] = { total: "20000000000000000000000", available: "20000000000000000000000" };
    const { data } = await connect();
    const r = await data("sell_outcome", { series: 45, side: "up", tokens: "10" });
    // 10 tokens at 0.470: 4.7 USDC less the 20 bps fee.
    expect(r.quote).toMatchObject({ tokensIn: "10", usdcOut: "4.6906", tokensSold: "10", minUsdcOut: "4.643694", worstPriceAllowed: 0.4, worstPrice: 0.47 });
    expect(r.spendUsdc).toBe("0");
    expect(r.calls).toEqual([K.outcomes.toBook(45, "up", "10000000", swapMsg("4643694"))]);
    expect((await data("sell_outcome", { series: 45, side: "up", tokens: "50" })).blocker).toBe("the account holds 40 up tokens of series 45, less than 50");
  });

  test("open_perp and close_perp build the perps contract's calls", async () => {
    const { data } = await connect();
    const open = await data("open_perp", { trend: TREND, side: "long", margin: "10", leverage: 2 });
    // margin = net + fee, fee = net x 2 x 10 bps: net 9.980039; entry at most 1% above 50.94.
    expect(open.quote).toMatchObject({ index: 50.94, leverage: 2, marginUsdc: "10", feeUsdc: "0.019961", netMarginUsdc: "9.980039", notionalUsdc: "19.960078", acceptableIndex: 51.4494, openInterestCapUsdc: "250000" });
    expect(open.calls).toEqual([storageCall(C.perps, 10n ** 22n), K.perps.open(TREND, true, "10000000", 20_000, 51_449_400)]);
    const close = await data("close_perp", { position: 7 });
    expect(close.quote).toMatchObject({ position: 7, side: "long", equityUsdc: 10.178, closeFeeUsdc: "0.010188", payoutUsdcAbout: "10.167812", acceptableIndex: 50.4306 });
    expect(close.calls).toEqual([K.perps.close(7, 50_430_600)]);
    const margin = await data("add_perp_margin", { position: 7, usdc: "3" });
    expect(margin.quote).toMatchObject({ marginUsdc: "9.99", marginAfterUsdc: "12.99", liquidationIndexNow: 34 });
    expect(margin.calls).toEqual([K.perps.addMargin(7, "3000000")]);
  });

  test("close_perp refuses a position the account does not own", async () => {
    views[`${C.perps}.get_position`] = { ...position, owner: "someone.testnet" };
    const { error } = await connect();
    expect(await error("close_perp", { position: 7 })).toBe("position 7 belongs to someone.testnet, not agent.testnet");
  });

  test("buy_coin and sell_coin take the coins contract's own quote", async () => {
    const { data } = await connect();
    const buy = await data("buy_coin", { trend: TREND, usdc: "2" });
    expect(buy.quote).toMatchObject({ coin: COIN, usdcIn: "2", coinsOut: "1000000", feeUsdc: "0.02", minCoinsOut: "980000", spotUsdc: "0.000002" });
    expect(buy.calls).toEqual([K.coins.buy(TREND, "2000000", "980000000000000000000000")]);
    // The quote passes the registry's peak, as a buy first raises the floor to it.
    expect(viewCalls.find((v) => v.key === `${C.coins}.quote_buy`)?.args).toEqual({ trend: TREND, usdc_in: "2000000", peak_index: 52_000_000 });
    const sell = await data("sell_coin", { trend: TREND, coins: "1000" });
    expect(sell.quote).toMatchObject({ coinsIn: "1000", usdcOut: "1.98", minUsdcOut: "1.9404" });
    expect(sell.calls).toEqual([K.coins.sell(COIN, "1000000000000000000000", "1940400")]);
  });

  test("blockers explain why a trade cannot go now; confirm then sends nothing", async () => {
    views[`${C.registry}.index_of`] = { ...(views[`${C.registry}.index_of`] as object), fresh: false };
    const { data, error, signer } = await connect();
    expect((await data("buy_outcome", { series: 45, side: "up", usdc: "5" })).blocker).toBe(`the index of ${TREND} is not fresh, and anchored swaps refuse a stale index`);
    expect(await error("open_perp", { trend: TREND, side: "short", margin: "5", confirm: true })).toBe(`not sent: the index of ${TREND} is not fresh, and the perps contract refuses a stale index`);
    views = baseViews();
    views[`${C.book}.depth`] = { series: 45, side: "up", asks: [{ tick: 650, price: "650000", size: "20000000" }], bids: [], last_tick: null };
    expect((await data("buy_outcome", { series: 45, side: "up", usdc: "5" })).blocker).toBe("nothing would fill: the book has no asks within the anchored band (0.10 USDC around the implied value 0.5)");
    views = baseViews();
    views[`${C.coins}.get_curve`] = { ...(views[`${C.coins}.get_curve`] as object), stage: "graduated", pool_id: 12 };
    expect((await data("buy_coin", { trend: TREND, usdc: "1" })).blocker).toBe("the curve is graduated: coins sell on the curve only while it is open (it trades on Rhea pool 12 now)");
    views = baseViews();
    views[`${C.usdc}.ft_balance_of`] = "1000000";
    expect((await data("open_perp", { trend: TREND, side: "long", margin: "2" })).blocker).toBe("the account holds 1 USDC, less than 2");
    expect(signer.sent).toEqual([]);
  });

  test("argument validation", async () => {
    const { call, error } = await connect();
    for (const usdc of ["abc", "0", "0.0", "1.1234567", "-1"]) expect((await call("buy_outcome", { series: 45, side: "up", usdc })).isError).toBe(true);
    expect((await call("buy_outcome", { series: 45, side: "sideways", usdc: "1" })).isError).toBe(true);
    expect((await call("open_perp", { trend: TREND, side: "long", margin: "5", leverage: 4 })).isError).toBe(true);
    expect((await call("open_perp", { trend: TREND, side: "long", margin: "5", slippageBps: 5000 })).isError).toBe(true);
    expect((await call("sell_coin", { trend: TREND, coins: "1.0000000000000000001" })).isError).toBe(true);
    expect((await call("post_call", { trend: TREND, direction: "up" })).isError).toBe(true);
    expect(await error("buy_outcome", { side: "up", usdc: "1" })).toBe("give a series id, or a trend and a window");
    expect(await error("sell_outcome", { series: 45, side: "up", tokens: "0.0005", confirm: true })).toBe("not sent: sell at least 0.001 tokens (the book trades lots of 0.001)");
  });
});

describe("the policy decides what is sent", () => {
  test("a tool the policy does not name only quotes", async () => {
    const { data, error, signer } = await connect({ policy: { dailyCapUsdc: "20", tools: { sell_outcome: true } } });
    const dry = await data("buy_outcome", { series: 45, side: "up", usdc: "5" });
    expect(dry).toMatchObject({ ready: false, blocker: expect.stringContaining("the trading policy refuses it: the trading policy does not allow buy_outcome") });
    expect(await error("buy_outcome", { series: 45, side: "up", usdc: "5", confirm: true })).toContain("not sent: the trading policy refuses it: the trading policy does not allow buy_outcome");
    expect(signer.sent).toEqual([]);
  });

  test("the cap per call and the daily cap across tools", async () => {
    const { data, error, signer, guard } = await connect();
    expect(await error("buy_outcome", { series: 45, side: "up", usdc: "10.5", confirm: true })).toBe("not sent: the trading policy refuses it: 10.5 USDC is above buy_outcome's cap of 10 USDC per call");
    expect(await error("buy_coin", { trend: TREND, usdc: "3.01", confirm: true })).toContain("above buy_coin's cap of 3 USDC per call");
    signer.answers.push(() => outcome("Open1", [event("tredio-perps", "position_opened", { id: 8, owner: AGENT, trend: TREND, is_long: true, qty: "1", margin: "14970000", entry_index: 50_940_000, fee: "30000", payer: AGENT })]));
    views[`${C.perps}.storage_balance_of`] = { total: String(10n ** 22n), available: String(10n ** 22n) };
    expect((await data("open_perp", { trend: TREND, side: "long", margin: "15", confirm: true })).result).toMatchObject({ position: 8, entryIndex: 50.94, marginUsdc: "14.97" });
    const over = await data("buy_outcome", { series: 45, side: "up", usdc: "6" });
    expect(over.policy).toMatchObject({ allowed: false, spentTodayUsdc: "15", leftTodayUsdc: "5" });
    expect(await error("buy_outcome", { series: 45, side: "up", usdc: "6", confirm: true })).toBe(
      "not sent: the trading policy refuses it: 6 USDC would bring today's spend (UTC) to 21 USDC, above the daily cap of 20 USDC; 5 USDC is left today",
    );
    // Selling spends nothing, so it still goes.
    views[`${C.outcomes}.storage_balance_of`] = { total: "20000000000000000000000", available: "20000000000000000000000" };
    expect((await data("sell_outcome", { series: 45, side: "up", tokens: "1", confirm: true })).sent).toBe(true);
    expect(guard.summary().trades.map((e) => [e.tool, e.usdc, e.status])).toEqual([
      ["open_perp", "15", "sent"],
      ["sell_outcome", "0", "sent"],
    ]);
  });

  test("a restart keeps the day's spend", async () => {
    const first = await connect();
    views[`${C.perps}.storage_balance_of`] = { total: String(10n ** 22n), available: String(10n ** 22n) };
    await first.data("open_perp", { trend: TREND, side: "long", margin: "12", confirm: true });
    const second = await connect();
    expect((await second.data("get_trading_policy")).today).toMatchObject({ spentUsdc: "12", leftUsdc: "8" });
    expect(await second.error("open_perp", { trend: TREND, side: "long", margin: "9", confirm: true })).toContain("8 USDC is left today");
  });

  test("a refusal the contract logged, or a failure on chain, spends nothing; an unknown outcome counts", async () => {
    views[`${C.perps}.storage_balance_of`] = { total: String(10n ** 22n), available: String(10n ** 22n) };
    const { error, signer, guard } = await connect();
    signer.answers.push(() => outcome("Refused1", [event("tredio-perps", "open_refused", { owner: AGENT, trend: TREND, reason: "price not acceptable", amount: "5000000" })]));
    expect(await error("open_perp", { trend: TREND, side: "long", margin: "5", confirm: true })).toBe(
      "the contract refused it: price not acceptable; the USDC went back. Transaction Refused1: https://testnet.nearblocks.io/txns/Refused1",
    );
    signer.answers.push(() => {
      throw new TxError("swap output below the minimum", "Failed1", outcome("Failed1") as never);
    });
    views[`${C.outcomes}.storage_balance_of`] = { total: "20000000000000000000000", available: "20000000000000000000000" };
    expect(await error("buy_outcome", { series: 45, side: "up", usdc: "4", confirm: true })).toContain("the transaction failed on chain: swap output below the minimum; nothing was spent");
    signer.answers.push(() => {
      throw new TxError("rpc 503", "Lost1");
    });
    expect(await error("buy_outcome", { series: 45, side: "up", usdc: "3", confirm: true })).toContain("the transaction's outcome is unknown: rpc 503. Look it up before trying again");
    expect(guard.summary()).toMatchObject({ spentUsdc: "3" });
    expect(guard.summary().trades.map((e) => [e.usdc, e.status, e.hash])).toEqual([
      ["5", "refused", "Refused1"],
      ["4", "failed", "Failed1"],
      ["3", "unknown", "Lost1"],
    ]);
  });

  test("a trade whose later receipt failed still counts as sent", async () => {
    views[`${C.outcomes}.storage_balance_of`] = { total: "20000000000000000000000", available: "20000000000000000000000" };
    const { data, signer, guard } = await connect();
    signer.answers.push(() => {
      throw new TxError("delivery failed", "Swap2", outcome("Swap2", [event("tredio-book", "swap", { account: AGENT, series: 45, side: "up", dir: "buy", anchored: true, fair: "500000", amount_in: "1000000", amount_out: "1880000" })]) as never);
    });
    const r = await data("buy_outcome", { series: 45, side: "up", usdc: "1", confirm: true });
    expect(r).toMatchObject({ sent: true, hash: "Swap2", warning: "the trade went through, but a later receipt failed: delivery failed", result: { tokensReceived: "1.88" } });
    expect(guard.summary().spentUsdc).toBe("1");
  });

  test("get_trading_policy shows the signer, the policy and today's trades", async () => {
    const { data } = await connect({ policy: { dailyCapUsdc: "8", tools: { buy_outcome: { maxUsdc: "2" } } } });
    const p = await data("get_trading_policy");
    expect(p).toMatchObject({ network: "testnet", signer: { path: "own key of a NEAR account", account: AGENT }, caller: null, today: { spentUsdc: "0", leftUsdc: "8", trades: [] } });
    expect(p.signer.canSend).toContain("buy_coin");
    expect(p.policy).toMatchObject({ dailyCapUsdc: "8", tools: { buy_outcome: { allowed: true, maxUsdcPerCall: "2" }, open_perp: { allowed: false } } });
  });
});

describe("the session path", () => {
  const sessionSigner = () => new FakeSigner("session", SESSION, SESSION_KEY);

  test("Up/Down and perps go through session_call with typed actions and the account's gas", async () => {
    const { data } = await connect({ signer: sessionSigner() });
    const buy = await data("buy_outcome", { series: 45, side: "up", usdc: "5" });
    expect(buy.signer.path).toBe("session key of a passkey account");
    expect(buy.calls).toEqual([K.account.sessionCall(SESSION, { swap: { series: 45, side: "up", buy: true, amount: "5000000", min_out: "9320850" } }, 150)]);
    expect(buy.session).toMatchObject({ label: "agent", dailyLimitUsdc: "100", leftTodayUsdc: "100", accountCodeVersion: 2, sessionCallTgas: 150, gasKeyNear: "0.313", gasPerCallNear: "0.15" });
    const sell = await data("sell_outcome", { series: 45, side: "up", tokens: "10" });
    expect(sell.calls).toEqual([K.account.sessionCall(SESSION, { swap: { series: 45, side: "up", buy: false, amount: "10000000", min_out: "4643694" } }, 150)]);
    const open = await data("open_perp", { trend: TREND, side: "short", margin: "10", leverage: 1.5 });
    expect(open.calls).toEqual([K.account.sessionCall(SESSION, { perp_open: { trend: TREND, is_long: false, margin: "10000000", leverage_bps: 15_000, acceptable_index: 50_430_600 } }, 150)]);
    views[`${C.perps}.get_position`] = { ...position, owner: SESSION };
    const close = await data("close_perp", { position: 7, slippageBps: 50 });
    expect(close.calls).toEqual([K.account.sessionCall(SESSION, { perp_close: { id: 7, acceptable_index: 50_685_300 } }, 150)]);
  });

  test("an account on v1 code attaches 300 Tgas", async () => {
    delete views[`${SESSION}.version`];
    const { data } = await connect({ signer: sessionSigner() });
    expect((await data("buy_outcome", { series: 45, side: "up", usdc: "1" })).calls[0].gas).toBe((300n * 10n ** 12n).toString());
  });

  test("coin trades and margin top-ups need the passkey, so a session only quotes them", async () => {
    views[`${C.perps}.get_position`] = { ...position, owner: SESSION };
    const { data, error, signer } = await connect({ signer: sessionSigner() });
    const coin = await data("buy_coin", { trend: TREND, usdc: "1" });
    expect(coin).toMatchObject({ ready: false, calls: [], quote: { coinsOut: "1000000" } });
    expect(coin.blocker).toContain("A coin trade is an owner action on a passkey account");
    expect(await error("sell_coin", { trend: TREND, coins: "1", confirm: true })).toContain("not sent: A coin trade is an owner action");
    expect(await error("add_perp_margin", { position: 7, usdc: "1", confirm: true })).toContain("not sent: Adding margin is an owner action");
    expect((await data("get_trading_policy")).signer.canSend).toEqual(["buy_outcome", "sell_outcome", "open_perp", "close_perp"]);
    expect(signer.sent).toEqual([]);
  });

  test("the session's own limits: scope, expiry and its on-chain daily limit", async () => {
    const session = views[`${SESSION}.session`] as Record<string, unknown>;
    views[`${SESSION}.session`] = { ...session, scope: { outcomes: true, perps: false, hyperliquid: false } };
    const { data } = await connect({ signer: sessionSigner() });
    expect((await data("open_perp", { trend: TREND, side: "long", margin: "5" })).blocker).toBe("the session's scope leaves out perps");
    views[`${SESSION}.session`] = { ...session, spent: "97000000" };
    expect((await data("buy_outcome", { series: 45, side: "up", usdc: "5" })).blocker).toBe("5 USDC is above what the session's on-chain daily limit leaves today (3 of 100 USDC)");
    views[`${SESSION}.session`] = { ...session, expires_at: NOW - 1 };
    expect((await data("buy_outcome", { series: 45, side: "up", usdc: "5" })).blocker).toContain("the session expired at");
    views[`${SESSION}.session`] = null;
    expect((await data("buy_outcome", { series: 45, side: "up", usdc: "5" })).blocker).toBe(`${SESSION_KEY} is not a session of ${SESSION}: it was never added or has been revoked`);
  });

  test("a gas key below what a call prepays is refilled by the relayer, or the trade is not sent", async () => {
    gasBalance = 10n ** 23n;
    const bare = await connect({ signer: sessionSigner() });
    expect(await bare.error("buy_outcome", { series: 45, side: "up", usdc: "5", confirm: true })).toContain("not sent: the session's gas key holds 0.1 NEAR, below the 0.15 NEAR a session call prepays; set TREDIO_RELAYER_URL");
    expect(bare.signer.sent).toEqual([]);
    expect(bare.guard.summary().trades.map((e) => e.status)).toEqual(["failed"]);
    const relayed = await connect({ signer: sessionSigner(), relayerUrl: "http://relayer.test" });
    expect((await relayed.data("buy_outcome", { series: 45, side: "up", usdc: "5", confirm: true })).sent).toBe(true);
    // The account has no storage at the outcomes contract in this scene, so the relayer adds it too, as for the app.
    expect(posted.map((p) => [p.url, p.body])).toEqual([
      ["http://relayer.test/v1/sessions/fund", { account: SESSION, publicKey: SESSION_KEY }],
      ["http://relayer.test/v1/storage/fund", { account: SESSION, contract: C.outcomes }],
    ]);
    expect(relayed.signer.sent.length).toBe(1);
  });
});

describe("post_call", () => {
  const seed = new Uint8Array(32).fill(9);
  const caller = callerKey(`ed25519:${base58Encode(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]))}`);

  test("the caller key is the identity: its public key in hex, ed25519 over the call text", () => {
    expect(caller.identity).toBe(Buffer.from(ed25519.getPublicKey(seed)).toString("hex"));
    expect(callerKey(`ed25519:${base58Encode(seed)}`).identity).toBe(caller.identity);
    expect(() => callerKey("ed25519:abc")).toThrow("a caller key is an ed25519 secret key");
  });

  test("a dry run shows the signed text; confirm posts it to the API and records it", async () => {
    const { data, guard } = await connect({ caller, signer: null });
    const dry = await data("post_call", { trend: TREND, direction: "up", horizon: "7d", note: "the final is on Sunday" });
    expect(dry).toMatchObject({ dryRun: true, ready: true, caller: caller.identity, api: "http://api.test/v1/calls", call: { trend: TREND, direction: "up", horizonSec: 604_800, indexNow: 50.94 } });
    expect(dry.signedText).toStartWith(`Tredio call\ntrend: ${TREND}\ndirection: up\nhorizon: 604800\nnote: `);
    const r = await data("post_call", { trend: TREND, direction: "up", horizon: "7d", note: "the final is on Sunday", confirm: true });
    expect(r).toMatchObject({ posted: true, caller: caller.identity, call: { id: 31, horizonSec: 604_800, openingIndex: 50.94, resolvesAt: NOW + 604_800 } });
    expect(posted[0]!.body).toMatchObject({ caller: caller.identity, identifier: TREND, direction: "up", horizonSec: 604_800, note: "the final is on Sunday" });
    expect(guard.summary().trades.map((e) => [e.tool, e.signer, e.account, e.status, e.hash])).toEqual([["post_call", "caller", caller.identity, "sent", "call:31"]]);
  });

  test("needs the policy to name it and a live trend", async () => {
    const { data, error } = await connect({ caller, signer: null, policy: { dailyCapUsdc: "0", tools: {} } });
    expect(await error("post_call", { trend: TREND, direction: "down", confirm: true })).toBe("not posted: the trading policy refuses it: the trading policy does not allow post_call; the user enables it by naming it under \"tools\" in the policy");
    views[`${C.registry}.index_of`] = { ...(views[`${C.registry}.index_of`] as object), status: "retired" };
    expect((await data("post_call", { trend: TREND, direction: "down" })).blocker).toBe(`${TREND} retired; calls are made on live trends`);
    expect(posted).toEqual([]);
  });

  test("with a caller key alone, only calls and the policy are offered", async () => {
    const { client, data } = await connect({ caller, signer: null });
    expect((await client.listTools()).tools.filter((t) => !t.annotations?.readOnlyHint || t.name === "get_trading_policy").map((t) => t.name).sort()).toEqual(["get_trading_policy", "post_call"]);
    expect(client.getInstructions()).toContain("The tools that send (post_call) are dry runs unless confirm is true");
    expect((await data("get_trading_policy")).signer).toBeNull();
  });
});
