import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  base58Encode,
  createPaymentPayload,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type RpcReader,
  type SettlementResponse,
  TxError,
  type Viewer,
} from "@tredio/chain";
import type { FinalExecutionOutcome } from "near-kit";
import type { ChainTrend } from "../src/chain";
import { loadConfig } from "../src/config";
import type { Sql } from "../src/db";
import { RelayerSettler, type Settlement, type Settler, transferred } from "../src/x402/near";
import { MAX_TIMEOUT_SECONDS } from "../src/x402/paywall";
import { x402Routes } from "../src/x402/routes";
import { type NearState, decodeSignedDelegate, verifyExact } from "../src/x402/scheme";
import { quietLog, testDb } from "./helpers";

const USDC = "usdc.tredio.testnet";
const TREASURY = "tredio-treasury.testnet";
const PAYER = "agent.testnet";
const RELAYER = "tredio-relayer.testnet";
const HEIGHT = 276_000_000;
const KEY_NONCE = 275_000_000_000_010n;

const required: PaymentRequirements = { scheme: "exact", network: "near:testnet", amount: "10000", asset: USDC, payTo: TREASURY, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { symbol: "USDC", decimals: 6 } };

const edSecret = () => `ed25519:${base58Encode(ed25519.utils.randomSecretKey())}`;
const ED = edSecret();

/** An RPC that answers the client's two reads: the final block and the access key. */
const clientRpc = (height = HEIGHT, nonce = KEY_NONCE): RpcReader => ({
  rpc: async <T>(method: string) => (method === "block" ? { header: { height } } : { nonce: Number(nonce), permission: "FullAccess" }) as T,
});

const pay = (o: { secret?: string; requirements?: PaymentRequirements; payer?: string; height?: number; nonce?: bigint } = {}) =>
  createPaymentPayload({ signer: { accountId: o.payer ?? PAYER, privateKey: o.secret ?? ED }, rpc: clientRpc(o.height, o.nonce), requirements: o.requirements ?? required });

/** A chain where the payer holds plenty, the treasury is registered and the key is a full-access key. */
function chain(over: Partial<{ height: bigint; nonce: bigint; kind: "FullAccess" | "FunctionCall" | "Unknown"; balance: bigint; registered: boolean; noKey: boolean; fail: string }> = {}): NearState {
  const s = { height: BigInt(HEIGHT), nonce: KEY_NONCE, kind: "FullAccess" as const, balance: 5_000_000n, registered: true, noKey: false, fail: "", ...over };
  const maybeFail = async <T>(name: string, v: T) => {
    if (s.fail === name) throw new Error("rpc 503");
    return v;
  };
  return {
    final: () =>
      maybeFail("height", {
        height: s.height,
        accessKey: () => maybeFail("key", s.noKey ? null : { nonce: s.nonce, kind: s.kind }),
        account: (a: string) => maybeFail("account", a === "missing.testnet" ? null : { codeHash: a === USDC ? "5ZB3cJ4m3mUkb8a1cDvKomJH2B7cd2bPq5gJxuL6yZrs" : "11111111111111111111111111111111" }),
        ftBalance: () => maybeFail("balance", s.balance),
        storageBalance: () => maybeFail("storage", { supported: true, registered: s.registered }),
      }),
  };
}

const policy = { relayers: [RELAYER] };

describe("NEAR exact payloads", () => {
  test("the client signs one ft_transfer with 1 yoctoNEAR inside the timeout window", async () => {
    const p = await pay();
    expect(p.x402Version).toBe(2);
    expect(p.accepted).toEqual(required);
    const d = decodeSignedDelegate(p.payload.signedDelegateAction);
    expect(d.senderId).toBe(PAYER);
    expect(d.receiverId).toBe(USDC);
    expect(d.nonce).toBe(KEY_NONCE + 1n);
    // Two blocks under the 60-block budget, so a verifier a block ahead still accepts it.
    expect(d.maxBlockHeight).toBe(BigInt(HEIGHT + 58));
    expect(d.actionCount).toBe(1);
    expect(d.functionCall?.methodName).toBe("ft_transfer");
    expect(d.functionCall?.deposit).toBe(1n);
    expect(JSON.parse(new TextDecoder().decode(d.functionCall!.args))).toEqual({ receiver_id: TREASURY, amount: "10000" });
    expect(d.verifySignature()).toBe(true);
    expect(d.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the nonce follows a transaction the key sent a moment ago, before it is final", async () => {
    const rpc: RpcReader = {
      rpc: async <T>(method: string, params: unknown) =>
        (method === "block" ? { header: { height: HEIGHT } } : { nonce: Number((params as { finality: string }).finality === "optimistic" ? KEY_NONCE + 1n : KEY_NONCE) }) as T,
    };
    const p = await createPaymentPayload({ signer: { accountId: PAYER, privateKey: ED }, rpc, requirements: required });
    expect(decodeSignedDelegate(p.payload.signedDelegateAction).nonce).toBe(KEY_NONCE + 2n);
  });

  test("a valid payment verifies and names the payer", async () => {
    const v = await verifyExact(await pay(), required, chain(), policy);
    expect(v).toMatchObject({ ok: true, payer: PAYER });
  });

  test("secp256k1 keys verify too", async () => {
    const secret = `secp256k1:${base58Encode(secp256k1.utils.randomSecretKey())}`;
    const p = await pay({ secret });
    const d = decodeSignedDelegate(p.payload.signedDelegateAction);
    expect(d.curve).toBe("secp256k1");
    expect(d.publicKey.startsWith("secp256k1:")).toBe(true);
    expect(await verifyExact(p, required, chain(), policy)).toMatchObject({ ok: true, payer: PAYER });
  });

  test("a tampered or re-signed payload fails the signature check", async () => {
    const p = await pay();
    const bytes = Buffer.from(p.payload.signedDelegateAction, "base64");
    // Flip a byte of the signature: still canonical, no longer valid.
    bytes[bytes.length - 1]! ^= 0xff;
    const tampered = { ...p, payload: { signedDelegateAction: bytes.toString("base64") } };
    expect(await verifyExact(tampered, required, chain(), policy)).toEqual({ ok: false, reason: "invalid_exact_near_payload_signature" });
    // Trailing bytes are not a canonical SignedDelegate.
    const padded = { ...p, payload: { signedDelegateAction: Buffer.concat([Buffer.from(p.payload.signedDelegateAction, "base64"), Buffer.from([0])]).toString("base64") } };
    expect(await verifyExact(padded, required, chain(), policy)).toMatchObject({ ok: false, reason: "invalid_exact_near_payload_signed_delegate_action" });
  });

  test("the accepted requirements and the signed transfer must both match what was asked", async () => {
    const p = await pay();
    const cases: Array<[PaymentPayload, PaymentRequirements, string]> = [
      [{ ...p, x402Version: 1 }, required, "invalid_x402_version"],
      [{ ...p, accepted: { ...p.accepted, scheme: "upto" } }, required, "unsupported_scheme"],
      [p, { ...required, network: "eip155:8453" }, "invalid_network"],
      [{ ...p, accepted: { ...p.accepted, network: "near:mainnet" } }, required, "invalid_exact_near_network_mismatch"],
      [{ ...p, accepted: { ...p.accepted, amount: "1" } }, required, "invalid_exact_near_amount_mismatch"],
      [{ ...p, accepted: { ...p.accepted, payTo: "other.testnet" } }, required, "invalid_exact_near_pay_to_mismatch"],
      [{ ...p, payload: {} as never }, required, "invalid_exact_near_payload_shape"],
    ];
    for (const [payload, req, reason] of cases) expect((await verifyExact(payload, req, chain(), policy)) as { reason?: string }).toMatchObject({ ok: false, reason });
    // Signed for another recipient or amount than the requirements it claims to accept.
    const elsewhere = await pay({ requirements: { ...required, payTo: "other.testnet" } });
    expect(await verifyExact({ ...elsewhere, accepted: required }, required, chain(), policy)).toMatchObject({ ok: false, reason: "invalid_exact_near_payload_recipient_mismatch", payer: PAYER });
    const less = await pay({ requirements: { ...required, amount: "9999" } });
    expect(await verifyExact({ ...less, accepted: required }, required, chain(), policy)).toMatchObject({ ok: false, reason: "invalid_exact_near_payload_amount_mismatch" });
    const otherToken = await pay({ requirements: { ...required, asset: "fake-usdc.testnet" } });
    expect(await verifyExact({ ...otherToken, accepted: required }, required, chain(), policy)).toMatchObject({ ok: false, reason: "invalid_exact_near_payload_token_contract_mismatch" });
  });

  test("expiry, window and nonce are checked against the final block and the key", async () => {
    const p = await pay();
    const reason = async (state: NearState, pol = policy) => ((await verifyExact(p, required, state, pol)) as { reason?: string }).reason;
    expect(await reason(chain({ height: BigInt(HEIGHT + 58) }))).toBe("invalid_exact_near_payload_delegate_action_expired");
    expect(await reason(chain({ height: BigInt(HEIGHT - 10) }))).toBe("invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout");
    expect(await reason(chain({ nonce: KEY_NONCE + 1n }))).toBe("invalid_exact_near_payload_delegate_action_nonce_already_used");
    expect(await reason(chain({ noKey: true }))).toBe("invalid_exact_near_access_key_not_found");
    expect(await reason(chain({ kind: "FunctionCall" }))).toBe("invalid_exact_near_function_call_key_not_allowed");
    expect(await reason(chain({ kind: "Unknown" }))).toBe("invalid_exact_near_unsupported_access_key_permission");
    expect(await reason(chain({ balance: 9_999n }))).toBe("insufficient_funds");
    expect(await reason(chain({ registered: false }))).toBe("invalid_exact_near_recipient_not_registered_for_storage");
    expect(await reason(chain(), { relayers: [PAYER] })).toBe("invalid_exact_near_relayer_cannot_be_payer");
    expect(await reason(chain(), { relayers: [] })).toBe("invalid_exact_near_no_relayer_configured");
    // Any read that fails refuses the payment.
    expect(await reason(chain({ fail: "height" }))).toBe("invalid_exact_near_current_block_height_unavailable");
    expect(await reason(chain({ fail: "key" }))).toBe("invalid_exact_near_access_key_lookup_failed");
    expect(await reason(chain({ fail: "balance" }))).toBe("invalid_exact_near_balance_check_failed");
    expect(await reason(chain({ fail: "storage" }))).toBe("invalid_exact_near_storage_check_failed");
    const missing = await pay({ payer: "missing.testnet" });
    expect(((await verifyExact(missing, required, chain(), policy)) as { reason?: string }).reason).toBe("invalid_exact_near_sender_account_not_found");
  });

  test("gas past the relayer's cap is refused", async () => {
    const p = await createPaymentPayload({ signer: { accountId: PAYER, privateKey: ED }, rpc: clientRpc(), requirements: required, gas: 150n * 10n ** 12n });
    expect(await verifyExact(p, required, chain(), policy)).toMatchObject({ ok: false, reason: "invalid_exact_near_payload_gas_limit_exceeded" });
  });

  test("headers are base64 JSON", () => {
    const v = { a: 1, b: "é" };
    expect(decodeHeader<typeof v>(encodeHeader(v))).toEqual(v);
    expect(() => decodeHeader("not base64!")).toThrow();
  });
});

describe("settlement", () => {
  const expectT = { asset: USDC, payTo: TREASURY, amount: "10000", payer: PAYER };
  const outcome = (logs: string[], status: unknown = { SuccessValue: "" }, executor = USDC): FinalExecutionOutcome =>
    ({ transaction: { hash: "TxHash1" }, status: { SuccessValue: "" }, receipts_outcome: [{ id: "r1", outcome: { executor_id: executor, logs, status } }] }) as unknown as FinalExecutionOutcome;
  const event = (data: object) => `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [data] })}`;

  test("success needs the token's ft_transfer event from payer to payee for the exact amount", () => {
    expect(transferred(outcome([event({ old_owner_id: PAYER, new_owner_id: TREASURY, amount: "10000" })]), expectT)).toBe(true);
    expect(transferred(outcome([event({ old_owner_id: PAYER, new_owner_id: TREASURY, amount: "9999" })]), expectT)).toBe(false);
    expect(transferred(outcome([event({ old_owner_id: PAYER, new_owner_id: "x.testnet", amount: "10000" })]), expectT)).toBe(false);
    expect(transferred(outcome([event({ old_owner_id: PAYER, new_owner_id: TREASURY, amount: "10000" })], { SuccessValue: "" }, "fake.testnet"), expectT)).toBe(false);
    expect(transferred(outcome([event({ old_owner_id: PAYER, new_owner_id: TREASURY, amount: "10000" })], { Failure: {} }), expectT)).toBe(false);
  });

  test("the relayer submits the delegate action and reads the outcome", async () => {
    const p = await pay();
    const sent: unknown[] = [];
    const relayer = (send: () => Promise<FinalExecutionOutcome>) =>
      new RelayerSettler({
        accountId: RELAYER,
        sendTx: async (build: (tx: { signedDelegateAction: (sd: unknown) => unknown }) => unknown, waitUntil: string) => {
          build({ signedDelegateAction: (sd) => sent.push({ sd, waitUntil }) });
          return send();
        },
      } as never);
    expect(relayer(async () => outcome([])).relayers).toEqual([RELAYER]);
    const ok = await relayer(async () => outcome([event({ old_owner_id: PAYER, new_owner_id: TREASURY, amount: "10000" })])).settle(p.payload.signedDelegateAction, expectT);
    expect(ok).toEqual({ status: "settled", transaction: "TxHash1" });
    expect(sent[0]).toMatchObject({ waitUntil: "FINAL" });
    expect(await relayer(async () => outcome([])).settle(p.payload.signedDelegateAction, expectT)).toMatchObject({ status: "failed", transaction: "TxHash1" });
    const failed = await relayer(async () => {
      throw new TxError("Smart contract panicked: The account doesn't have enough balance", "TxHash2");
    }).settle(p.payload.signedDelegateAction, expectT);
    expect(failed).toMatchObject({ status: "failed", transaction: "TxHash2" });
    const lost = await relayer(async () => {
      throw new TxError("fetch failed", "TxHash3");
    }).settle(p.payload.signedDelegateAction, expectT);
    expect(lost).toMatchObject({ status: "pending", transaction: "TxHash3" });
  });
});

describe("paid routes", () => {
  let sql: Sql;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused@localhost/x", ORACLE_TOKEN: "test-oracle-token-123456", NEAR_NETWORK: "testnet" });
  const NOW = 1_793_940_000;
  const trend: ChainTrend = { id: "topic:world-cup", identifier: "topic:world-cup", assetClass: 6, status: "Active", createdAt: NOW - 86_400 * 10, updatedAt: NOW - 60, statusSince: NOW - 86_400 * 10, index: 51.88, peakIndex: 52.49, surfacer: "tredio.testnet", reviewHash: null, asset: null };
  const SIGNAL_LEADER = "c".repeat(64);
  const settled: string[] = [];
  // Every settlement is its own transaction.
  const settle = async (): Promise<Settlement> => ({ status: "settled", transaction: `TxSettled${settled.length}` });
  let next = settle;
  const settler: Settler = {
    relayers: [RELAYER],
    settle: async (b64) => {
      settled.push(b64);
      return next();
    },
  };
  let backtest: () => Promise<unknown> = async () => ({ trades: [], stats: {}, equity: [], warnings: [], trendId: trend.id, resolutionSec: 900 });
  let app: ReturnType<typeof x402Routes>;
  const make = (s: Settler | null) =>
    x402Routes({
      cfg,
      sql,
      viewer: {} as Viewer,
      trends: async () => [trend],
      history: { points: async (id: string, from = 0, to = Number.MAX_SAFE_INTEGER) => ((await sql<{ observed_at: string; points: number }[]>`SELECT observed_at, points FROM index_points WHERE trend_id = ${id} AND observed_at >= ${from} AND observed_at <= ${to} ORDER BY observed_at`).map((r) => ({ t: Number(r.observed_at), v: r.points }))) },
      backtest: (() => backtest()) as never,
      log: quietLog,
      now: () => NOW * 1000,
      state: chain(),
      settler: s,
      signalKeys: async (leader) => (leader === SIGNAL_LEADER ? { payTo: "leader.testnet", amount: 2_000_000n, periodDays: 30, keys: async () => [{ epoch: 2966, key: "k".repeat(64) }] } : null),
    });

  beforeAll(async () => {
    sql = await testDb();
  });
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await sql`TRUNCATE x402_payments, index_points RESTART IDENTITY`;
    await sql`TRUNCATE measurements RESTART IDENTITY`;
    // Ten days of checkpoints every 5 minutes, and readings every half hour.
    const points = Array.from({ length: 2880 }, (_, i) => ({ trend_id: trend.id, observed_at: NOW - 86_400 * 10 + i * 300, points: 50 + (i % 7) }));
    for (let i = 0; i < points.length; i += 1000) await sql`INSERT INTO index_points ${sql(points.slice(i, i + 1000), "trend_id", "observed_at", "points")}`;
    const readings = Array.from({ length: 480 }, (_, i) => ({ identifier: "topic:world-cup", source: i % 2 ? "gdelt" : "bluesky", metric: i % 2 ? "articles" : "posts", value: i, window_sec: 86_400, observed_at: new Date((NOW - 86_400 * 10 + i * 1800) * 1000) }));
    await sql`INSERT INTO measurements ${sql(readings, "identifier", "source", "metric", "value", "window_sec", "observed_at")}`;
    settled.length = 0;
    next = settle;
    app = make(settler);
  });

  const get = (path: string, payment?: PaymentPayload | string) =>
    app.request(path, { headers: payment ? { "PAYMENT-SIGNATURE": typeof payment === "string" ? payment : encodeHeader(payment) } : {} });
  const requiredOf = (res: Response) => decodeHeader<PaymentRequired>(res.headers.get("PAYMENT-REQUIRED")!);
  const responseOf = (res: Response) => decodeHeader<SettlementResponse>(res.headers.get("PAYMENT-RESPONSE")!);

  test("the discovery route lists the paid resources and who is paid", async () => {
    const body = (await (await app.request("/x402")).json()) as { enabled: boolean; network: string; asset: string; payTo: string; relayers: string[]; resources: Array<{ path: string; amount: string; usdc: string }> };
    expect(body).toMatchObject({ enabled: true, network: "near:testnet", asset: USDC, payTo: TREASURY, relayers: [RELAYER] });
    expect(body.resources.map((r) => [r.path, r.amount, r.usdc])).toEqual([
      ["/v1/x402/trends/{identifier}/history", "10000", "0.01"],
      ["/v1/x402/backtests", "20000", "0.02"],
      ["/v1/x402/signals/{leader}/keys", "per channel", "per channel"],
    ]);
  });

  test("an unpaid request gets 402 with the requirements in the header and the body", async () => {
    const res = await get("/x402/trends/topic:world-cup/history");
    expect(res.status).toBe(402);
    const pr = requiredOf(res);
    expect(pr).toMatchObject({ x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: "http://localhost/x402/trends/topic:world-cup/history", mimeType: "application/json" } });
    expect(pr.accepts).toEqual([required]);
    expect(await res.json()).toEqual(pr);
  });

  test("free checks come before payment: an unknown trend is a 404, a bad payload a 400", async () => {
    expect((await get("/x402/trends/topic:nope/history")).status).toBe(404);
    expect((await get("/x402/trends/topic:world-cup/history?from=abc")).status).toBe(400);
    expect((await get("/x402/trends/topic:world-cup/history", "bm90IGpzb24=")).status).toBe(400);
  });

  test("a paid request gets every checkpoint and reading, once", async () => {
    const payment = await pay();
    const res = await get("/x402/trends/topic:world-cup/history", payment);
    expect(res.status).toBe(200);
    expect(responseOf(res)).toEqual({ success: true, transaction: "TxSettled1", network: "near:testnet", payer: PAYER, amount: "10000" });
    const body = (await res.json()) as { index: unknown[]; readings: Array<{ source: string; metric: string; windowSec: number }>; from: number; to: number; truncated: boolean };
    // All ten days, not the free route's seven.
    expect(body.index.length).toBe(2880);
    expect(body.readings.length).toBe(480);
    expect(body.readings[1]).toMatchObject({ source: "gdelt", metric: "articles", windowSec: 86_400 });
    expect(body).toMatchObject({ from: 0, to: NOW, truncated: false });
    expect(settled).toEqual([payment.payload.signedDelegateAction]);
    const [row] = await sql<{ status: string; tx_hash: string; payer: string; amount: string; resource: string }[]>`SELECT status, tx_hash, payer, amount::text, resource FROM x402_payments`;
    expect(row).toEqual({ status: "settled", tx_hash: "TxSettled1", payer: PAYER, amount: "10000", resource: "/x402/trends/topic:world-cup/history" });
    // The same payment never buys a second answer.
    const again = await get("/x402/trends/topic:world-cup/history", payment);
    expect(again.status).toBe(402);
    expect(requiredOf(again).error).toBe("duplicate_settlement");
    expect(responseOf(again)).toMatchObject({ success: false, errorReason: "duplicate_settlement" });
    expect(settled.length).toBe(1);
  });

  test("a signals channel's viewing keys are paid to the leader's account, at the leader's price", async () => {
    const unpaid = await get(`/x402/signals/${SIGNAL_LEADER}/keys`);
    expect(unpaid.status).toBe(402);
    const leaderPrice = { ...required, payTo: "leader.testnet", amount: "2000000" };
    expect(requiredOf(unpaid).accepts).toEqual([leaderPrice]);
    // Paying the treasury instead does not buy them.
    expect((await get(`/x402/signals/${SIGNAL_LEADER}/keys`, await pay())).status).toBe(402);
    const res = await get(`/x402/signals/${SIGNAL_LEADER}/keys`, await pay({ requirements: leaderPrice, nonce: KEY_NONCE + 2n }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leader: SIGNAL_LEADER, keys: [{ epoch: 2966, key: "k".repeat(64) }] });
    expect(responseOf(res)).toMatchObject({ success: true, amount: "2000000" });
    expect((await get(`/x402/signals/${"d".repeat(64)}/keys`)).status).toBe(404);
  });

  test("a range narrows the history", async () => {
    const res = await get(`/x402/trends/topic:world-cup/history?from=${NOW - 86_400}&to=${NOW}`, await pay());
    const body = (await res.json()) as { index: Array<{ t: number }>; readings: unknown[] };
    expect(body.index.length).toBe(288);
    expect(body.index.every((p) => p.t >= NOW - 86_400)).toBe(true);
    expect(body.readings.length).toBe(48);
  });

  test("a refused payment is a 402 with the reason", async () => {
    const wrong = await pay({ requirements: { ...required, amount: "1" } });
    const res = await get("/x402/trends/topic:world-cup/history", wrong);
    expect(res.status).toBe(402);
    expect(requiredOf(res).error).toBe("invalid_exact_near_amount_mismatch");
    expect(settled.length).toBe(0);
  });

  test("a failed settlement answers 402 without the data and frees the payload", async () => {
    next = async () => ({ status: "failed", transaction: "TxFailed1", error: "Smart contract panicked: The account doesn't have enough balance" });
    const payment = await pay();
    const res = await get("/x402/trends/topic:world-cup/history", payment);
    expect(res.status).toBe(402);
    expect(responseOf(res)).toEqual({ success: false, errorReason: "settlement_failed", transaction: "TxFailed1", network: "near:testnet", payer: PAYER });
    expect(((await res.json()) as { index?: unknown }).index).toBeUndefined();
    next = settle;
    expect((await get("/x402/trends/topic:world-cup/history", payment)).status).toBe(200);
    expect((await sql<{ status: string }[]>`SELECT status FROM x402_payments ORDER BY id`).map((r) => r.status)).toEqual(["failed", "settled"]);
  });

  test("an unknown outcome keeps the payload claimed", async () => {
    next = async () => ({ status: "pending", transaction: "TxLost1", error: "fetch failed" });
    const payment = await pay();
    const res = await get("/x402/trends/topic:world-cup/history", payment);
    expect(responseOf(res)).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: "TxLost1" });
    expect(requiredOf(await get("/x402/trends/topic:world-cup/history", payment)).error).toBe("duplicate_settlement");
  });

  test("backtests are paid, and a rule the backtester cannot run is not charged", async () => {
    const rule = {
      name: "World Cup breakout",
      market: "ETH",
      trend: "topic:world-cup",
      entry: { attentionChangePct: 10, windowMin: 60, side: "long" },
      size: { marginUsdc: 10, leverage: 2 },
      exits: { stopLossPct: 5, takeProfitPct: 10 },
      limits: { maxPositionUsdc: 50, maxDailyLossUsdc: 20 },
    };
    const post = (body: unknown, payment?: PaymentPayload) =>
      app.request("/x402/backtests", { method: "POST", headers: { "content-type": "application/json", ...(payment ? { "PAYMENT-SIGNATURE": encodeHeader(payment) } : {}) }, body: JSON.stringify(body) });
    expect((await post({ rule: { name: "x" } })).status).toBe(400);
    const unpaid = await post({ rule, days: 7 });
    if (unpaid.status === 400) throw new Error(`the test rule is not valid: ${JSON.stringify(await unpaid.json())}`);
    expect(unpaid.status).toBe(402);
    expect(requiredOf(unpaid).accepts[0]!.amount).toBe("20000");
    const backtestPrice = { ...required, amount: "20000" };
    const ok = await post({ rule, days: 7 }, await pay({ requirements: backtestPrice }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { resolutionSec: number } }).result.resolutionSec).toBe(900);
    backtest = async () => {
      throw new Error("Hyperliquid has no ETH perp on this network");
    };
    // The chain moved the key's nonce past the first payment.
    const payment = await pay({ requirements: backtestPrice, nonce: KEY_NONCE + 1n });
    const failed = await post({ rule, days: 7 }, payment);
    expect(failed.status).toBe(422);
    expect(settled.length).toBe(1);
    // Released: the same payment still buys a backtest that runs.
    backtest = async () => ({ trades: [], stats: {}, equity: [], warnings: [], trendId: trend.id, resolutionSec: 900 });
    expect((await post({ rule, days: 7 }, payment)).status).toBe(200);
  });

  test("paid routes are rate limited per client address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await get("/x402/trends/topic:nope/history")).status);
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
    // The free discovery route is not.
    expect((await app.request("/x402")).status).toBe(200);
  });

  test("without a relayer the paid routes are off", async () => {
    app = make(null);
    expect((await get("/x402/trends/topic:world-cup/history")).status).toBe(503);
    expect(((await (await app.request("/x402")).json()) as { enabled: boolean }).enabled).toBe(false);
  });
});
