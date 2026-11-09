import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ACCESS_MEMO_PREFIX, COMMIT_MEMO_PREFIX, channelMessage, epochOf, openSignal, signalCommitment, signalMessage } from "@tredio/autopilot";
import type { Viewer } from "@tredio/chain";
import type { Deployment } from "@tredio/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import type { Sql } from "../src/db";
import { moderationRoutes } from "../src/social/moderation";
import { openStoredSignal, paidSignalKeys, pauseLapsedSignalFollows, signalAccessActive, signalsRoutes } from "../src/signals/routes";
import { testDb } from "./helpers";

/**
 * Paid signals on Postgres: a leader's channel, a signal taken only with its on-chain commitment,
 * the feed sealed until the reveal, viewing keys for the leader and for buyers whose USDC payment the
 * API read back from the chain, and follows of a channel paused when access ends.
 */

const NOW = 1_794_000_000;
const USDC = "usdc.tredio.testnet";
const TREASURY = "tredio-treasury.testnet";
const LEADER_ACCOUNT = "0uleader";
const BUYER = "0ubuyer";
const SECRET = new Uint8Array(32).fill(3);
const secretKey = ed25519.utils.randomSecretKey();
const IDENTITY = Buffer.from(ed25519.getPublicKey(secretKey)).toString("hex");
const sign = (message: string) => Buffer.from(ed25519.sign(new TextEncoder().encode(message), secretKey)).toString("base64");
/** Base58 transaction hashes, one per letter. */
const tx = (c: string) => c.repeat(44);

/** USDC transfers the fake chain holds, by transaction hash: the NEP-141 event the USDC contract logs. */
let transfers = new Map<string, { from: string; to: string; amount: string; memo: string; at: number; failed?: boolean }>();
const viewer: Pick<Viewer, "rpc"> = {
  rpc: async <T>(method: string, params: unknown) => {
    const p = params as { tx_hash?: string; block_id?: string };
    if (method === "block") return { header: { timestamp_nanosec: (BigInt(p.block_id!.slice(6)) * 1_000_000_000n).toString() } } as T;
    const t = transfers.get(p.tx_hash!);
    if (!t) throw new Error("UNKNOWN_TRANSACTION");
    const event = { standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: t.from, new_owner_id: t.to, amount: t.amount, memo: t.memo }] };
    return {
      status: t.failed ? { Failure: {} } : { SuccessValue: "" },
      receipts_outcome: [{ block_hash: `block-${t.at}`, outcome: { executor_id: USDC, status: { SuccessValue: "" }, logs: [`EVENT_JSON:${JSON.stringify(event)}`] } }],
    } as T;
  },
};

let sql: Sql;
let now = NOW;
/** The signed-in account comes from a header, as the real middleware sets it from a token. */
const signedIn: MiddlewareHandler<{ Variables: { user: string; token: string } }> = async (c, next) => {
  const user = c.req.header("x-user");
  if (!user) return c.json({ error: "sign in" }, 401);
  c.set("user", user);
  c.set("token", "t");
  await next();
};
const app = () =>
  signalsRoutes({ sql, viewer, deployment: { contracts: { usdc: USDC }, treasury: TREASURY } as unknown as Deployment, secret: SECRET, signedIn, mark: async (m) => (m === "BTC" ? 76_000 : null), now: () => now * 1000 });
const call = async <T>(method: string, path: string, body?: unknown, user?: string) => {
  const res = await app().request(path, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
};

async function openChannel(o: { price?: string; delay?: number } = {}) {
  const body = { priceUsdc: o.price ?? "5000000", periodDays: 30, revealDelaySec: o.delay ?? 3600, issuedAt: now };
  return call<{ channel: { leader: string; account: string } }>("PUT", "/signals/channel", { caller: IDENTITY, ...body, signature: sign(channelMessage(body)) });
}

const fields = { kind: "open" as const, market: "BTC", side: "long" as const, marginUsdc: 100, leverage: 5, note: "breakout" };
/** A signal signed now and committed on chain in `hash`, 5 seconds later. */
async function publish(hash: string, over: { memo?: string; from?: string } = {}) {
  const issuedAt = now;
  const signed = { ...fields, issuedAt };
  const commitment = await signalCommitment(IDENTITY, signed);
  transfers.set(hash, { from: over.from ?? LEADER_ACCOUNT, to: TREASURY, amount: "1", memo: over.memo ?? COMMIT_MEMO_PREFIX + commitment, at: issuedAt + 5 });
  const res = await call<{ signal: { id: number; revealAt: number; commitment: string }; error?: string }>("POST", "/signals", {
    caller: IDENTITY,
    signal: fields,
    issuedAt,
    signature: sign(await signalMessage(IDENTITY, signed)),
    commitTx: hash,
    commitSender: "tredio-relayer.testnet",
  });
  return { ...res, commitment };
}

beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE moderation_log, signal_access, signals, signal_channels, follows, callers RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO callers (address, handle, linked_account) VALUES (${IDENTITY}, 'chartist', ${LEADER_ACCOUNT})`;
  transfers = new Map();
  now = NOW;
});

describe("channels", () => {
  test("a linked caller opens a channel with its key's signature; an unlinked one or a bad signature cannot", async () => {
    const bad = { priceUsdc: "5000000", periodDays: 30, revealDelaySec: 3600, issuedAt: now };
    expect((await call("PUT", "/signals/channel", { caller: IDENTITY, ...bad, signature: sign(channelMessage({ ...bad, priceUsdc: "1" })) })).status).toBe(401);
    await sql`UPDATE callers SET linked_account = NULL`;
    expect((await openChannel()).status).toBe(409);
    await sql`UPDATE callers SET linked_account = ${LEADER_ACCOUNT}`;
    const ok = await openChannel();
    expect(ok.status).toBe(200);
    expect(ok.body.channel).toMatchObject({ leader: IDENTITY, account: LEADER_ACCOUNT, handle: "chartist", price_usdc: "5000000", reveal_delay_sec: 3600 });
    const list = await call<{ channels: Array<{ leaderId: string; signals: number }> }>("GET", "/signals/channels");
    expect(list.body.channels).toEqual([expect.objectContaining({ leaderId: `signals:${IDENTITY}`, signals: 0 })]);
  });
});

describe("signals", () => {
  test("a signal is taken only with a commitment from the leader's account, then stays sealed until its reveal", async () => {
    await openChannel();
    expect((await publish(tx("a"), { memo: `${COMMIT_MEMO_PREFIX}${"0".repeat(64)}` })).status).toBe(400);
    expect((await publish(tx("b"), { from: "someone.testnet" })).status).toBe(400);
    const ok = await publish(tx("c"));
    expect(ok.status).toBe(201);
    expect(ok.body.signal.revealAt).toBe(NOW + 5 + 3600);
    // The same commitment transaction never carries a second signal.
    expect((await publish(tx("c"))).status).toBe(409);

    const sealed = await call<{ signals: Array<{ signal: unknown; commitment: string; epoch: number; iv: string; ciphertext: string }> }>("GET", `/signals?leader=${IDENTITY}`);
    expect(sealed.body.signals).toHaveLength(1);
    expect(sealed.body.signals[0]).toMatchObject({ signal: null, commitment: ok.commitment, epoch: epochOf(NOW) });
    now = NOW + 5 + 3600;
    const open = await call<{ signals: Array<{ signal: Record<string, unknown> | null }> }>("GET", "/signals");
    expect(open.body.signals[0]!.signal).toMatchObject({ ...fields, leader: IDENTITY, issuedAt: NOW, price: 76_000 });
  });

  test("an admin hides a signal from the feed and the channel's count, and restores it, as with calls and posts", async () => {
    await openChannel();
    const { body } = await publish(tx("n"));
    const admin = new Hono<{ Variables: { admin: string } }>()
      .use("*", async (c, next) => {
        c.set("admin", "admin.testnet");
        await next();
      })
      .route("/", moderationRoutes({ sql, open: (x) => openStoredSignal(SECRET, x) }));
    const listed = (await (await admin.request("/social/signals")).json()) as { total: number; rows: Array<{ identifier: string; signal: { note: string } | null; commitTx: string }> };
    expect(listed.total).toBe(1);
    expect(listed.rows[0]).toMatchObject({ identifier: "BTC-PERP", signal: { note: "breakout" }, commitTx: tx("n") });
    const sealed = new Hono<{ Variables: { admin: string } }>().route("/", moderationRoutes({ sql }));
    expect(((await (await sealed.request("/social/signals")).json()) as { rows: Array<{ identifier: string; signal: unknown }> }).rows[0]).toMatchObject({ identifier: "sealed", signal: null });
    const act = (what: "hide" | "restore") => admin.request(`/social/signals/${body.signal.id}/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "abuse in the note" }) });
    expect((await act("hide")).status).toBe(200);
    expect((await call<{ signals: unknown[] }>("GET", "/signals")).body.signals).toHaveLength(0);
    expect((await call<{ channels: Array<{ signals: number }> }>("GET", "/signals/channels")).body.channels[0]!.signals).toBe(0);
    expect((await act("hide")).status).toBe(409);
    expect((await act("restore")).status).toBe(200);
    expect((await call<{ signals: unknown[] }>("GET", "/signals")).body.signals).toHaveLength(1);
    const [log] = await sql<{ action: string; target: string }[]>`SELECT action, target FROM moderation_log ORDER BY id LIMIT 1`;
    expect(log).toEqual({ action: "hide_signal", target: `signals:${body.signal.id}` });
  });

  test("a commitment that landed long after the signal was signed is refused", async () => {
    await openChannel();
    const issuedAt = now;
    const signed = { ...fields, issuedAt };
    const commitment = await signalCommitment(IDENTITY, signed);
    transfers.set(tx("d"), { from: LEADER_ACCOUNT, to: TREASURY, amount: "1", memo: COMMIT_MEMO_PREFIX + commitment, at: issuedAt + 3600 });
    now = issuedAt + 200;
    const res = await call<{ error: string }>("POST", "/signals", { caller: IDENTITY, signal: fields, issuedAt, signature: sign(await signalMessage(IDENTITY, signed)), commitTx: tx("d"), commitSender: "tredio-relayer.testnet" });
    expect(res).toMatchObject({ status: 400, body: { error: "the commitment landed outside the signal's time" } });
  });
});

describe("early access", () => {
  test("viewing keys go to the leader and to buyers whose payment the chain shows, for the weeks they paid for", async () => {
    await openChannel();
    const signal = await publish(tx("e"));
    const [row] = await sql<{ iv: string; ciphertext: string; epoch: number }[]>`SELECT iv, ciphertext, epoch FROM signals`;

    const leader = await call<{ keys: Array<{ epoch: number; key: string }> }>("GET", `/signals/${IDENTITY}/keys`, undefined, LEADER_ACCOUNT);
    expect(leader.status).toBe(200);
    expect(leader.body.keys.length).toBeGreaterThan(1);
    const none = await call<{ priceUsdc: string; payTo: string }>("GET", `/signals/${IDENTITY}/keys`, undefined, BUYER);
    expect(none).toMatchObject({ status: 402, body: { priceUsdc: "5000000", payTo: LEADER_ACCOUNT } });

    // Too little, to the wrong account, or for another channel: no access.
    transfers.set(tx("f"), { from: BUYER, to: LEADER_ACCOUNT, amount: "4999999", memo: ACCESS_MEMO_PREFIX + IDENTITY, at: now });
    transfers.set(tx("g"), { from: BUYER, to: TREASURY, amount: "5000000", memo: ACCESS_MEMO_PREFIX + IDENTITY, at: now });
    transfers.set(tx("h"), { from: BUYER, to: LEADER_ACCOUNT, amount: "5000000", memo: `${ACCESS_MEMO_PREFIX}${"b".repeat(64)}`, at: now });
    for (const h of ["f", "g", "h"]) expect((await call("POST", `/signals/${IDENTITY}/access`, { tx: tx(h), sender: BUYER }, BUYER)).status).toBe(400);
    // A stale payment does not count either.
    transfers.set(tx("i"), { from: BUYER, to: LEADER_ACCOUNT, amount: "5000000", memo: ACCESS_MEMO_PREFIX + IDENTITY, at: now - 7200 });
    expect((await call("POST", `/signals/${IDENTITY}/access`, { tx: tx("i"), sender: BUYER }, BUYER)).status).toBe(400);

    transfers.set(tx("j"), { from: BUYER, to: LEADER_ACCOUNT, amount: "5000000", memo: ACCESS_MEMO_PREFIX + IDENTITY, at: now - 30 });
    const bought = await call<{ startsAt: number; expiresAt: number }>("POST", `/signals/${IDENTITY}/access`, { tx: tx("j"), sender: "tredio-relayer.testnet" }, BUYER);
    expect(bought).toMatchObject({ status: 201, body: { startsAt: NOW, expiresAt: NOW + 30 * 86_400 } });
    expect((await call("POST", `/signals/${IDENTITY}/access`, { tx: tx("j"), sender: BUYER }, BUYER)).status).toBe(409);
    // A renewal starts where the current access ends.
    transfers.set(tx("k"), { from: BUYER, to: LEADER_ACCOUNT, amount: "5000000", memo: ACCESS_MEMO_PREFIX + IDENTITY, at: now });
    expect((await call<{ expiresAt: number }>("POST", `/signals/${IDENTITY}/access`, { tx: tx("k"), sender: BUYER }, BUYER)).body.expiresAt).toBe(NOW + 60 * 86_400);

    const keys = await call<{ keys: Array<{ epoch: number; key: string }>; expiresAt: number }>("GET", `/signals/${IDENTITY}/keys`, undefined, BUYER);
    expect(keys.status).toBe(200);
    expect(keys.body.keys.map((k) => k.epoch)).toEqual([epochOf(NOW)]);
    const opened = await openSignal(keys.body.keys[0]!.key, row!, signal.commitment);
    expect(opened).toMatchObject({ ...fields, price: 76_000 });
    expect(await call<{ active: boolean }>("GET", `/signals/${IDENTITY}/access`, undefined, BUYER)).toMatchObject({ body: { active: true } });
  });

  test("agents pay the leader over x402 for the next period's keys", async () => {
    await openChannel({ price: "2000000" });
    const offer = await paidSignalKeys({ sql, secret: SECRET }, IDENTITY, NOW);
    expect(offer).toMatchObject({ payTo: LEADER_ACCOUNT, amount: 2_000_000n, periodDays: 30 });
    expect((await offer!.keys()).map((k) => k.epoch)).toEqual([epochOf(NOW), epochOf(NOW) + 1, epochOf(NOW) + 2, epochOf(NOW) + 3, epochOf(NOW) + 4].filter((e) => e <= epochOf(NOW + 30 * 86_400)));
    expect(await paidSignalKeys({ sql, secret: SECRET }, "d".repeat(64), NOW)).toBeNull();
    expect(await paidSignalKeys({ sql, secret: null }, IDENTITY, NOW)).toBeNull();
  });

  test("a follow of a channel needs active access, and pauses when it ends", async () => {
    await openChannel();
    const leader = `signals:${IDENTITY}`;
    expect(await signalAccessActive(sql, BUYER, leader, NOW)).toBe(false);
    await sql`INSERT INTO signal_access (buyer, leader, starts_at, expires_at, amount, payment_tx) VALUES (${BUYER}, ${IDENTITY}, ${NOW}, ${NOW + 86_400}, 5000000, ${tx("m")})`;
    expect(await signalAccessActive(sql, BUYER, leader, NOW)).toBe(true);
    expect(await signalAccessActive(sql, BUYER, "0x972dac64d693f387cd089f0efcda320c71097a2c", NOW)).toBe(false);
    await sql`INSERT INTO follows (follower, leader, settings) VALUES (${BUYER}, ${leader}, '{}'), (${BUYER}, '0x972dac64d693f387cd089f0efcda320c71097a2c', '{}')`;
    expect(await pauseLapsedSignalFollows(sql, NOW + 60)).toBe(0);
    expect(await pauseLapsedSignalFollows(sql, NOW + 86_400)).toBe(1);
    const rows = await sql<{ leader: string; status: string; status_reason: string | null }[]>`SELECT leader, status, status_reason FROM follows ORDER BY id`;
    expect(rows.map((r) => r.status)).toEqual(["paused", "active"]);
    expect(rows[0]!.status_reason).toContain("early access to these signals ended");
  });
});
