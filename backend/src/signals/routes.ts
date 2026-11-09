import { ed25519 } from "@noble/curves/ed25519.js";
import type { Viewer } from "@tredio/chain";
import type { Deployment } from "@tredio/contracts";
import {
  ACCESS_MEMO_PREFIX,
  COMMIT_AMOUNT,
  channelMessage,
  COMMIT_MEMO_PREFIX,
  epochOf,
  openSignal,
  sealSignal,
  type Signal,
  signalCommitment,
  signalInputSchema,
  signalLeader,
  signalMessage,
  viewingKey,
} from "@tredio/autopilot";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Sql } from "../db";
import { findTransfer, usdcTransfers } from "./chain";

/**
 * Paid private trade signals (packages/autopilot/src/signals.ts says what is private and what is
 * not). A leader opens a channel with a price, a period and a reveal delay; each signal is signed by
 * the leader's caller key and committed on chain from the leader's linked account before the API
 * takes it, then stored sealed under that week's viewing key. Anyone reads the feed; early access
 * (the viewing keys) is bought in USDC on NEAR, by a transfer to the leader's account in the app or
 * over x402 for agents. After the delay the API publishes each signal, and anyone can check it
 * against its on-chain commitment. A follow whose leader is `signals:<identity>` copies the signals
 * through Autopilot while the follower's access lasts.
 */

export const SIGNED_WINDOW_SEC = 300;
/** A commitment must land within this of the signal's issue time. */
export const COMMIT_WINDOW_SEC = 600;
export const MAX_SIGNALS_PER_DAY = 30;
/** The leader reads its own signals from this many weeks back. */
const LEADER_KEY_WEEKS = 8;


const identity = z.string().regex(/^[0-9a-f]{64}$/, "an identity is a 32-byte ed25519 key in hex");
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "bad signature");
const txHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "a transaction hash");
const account = z.string().regex(/^[a-z0-9._-]{2,64}$/);
const channelBody = z.object({
  caller: identity,
  priceUsdc: z.string().regex(/^\d{1,12}$/, "USDC in atomic units (6 decimals)"),
  periodDays: z.number().int().min(1).max(90),
  revealDelaySec: z.number().int().min(300).max(604_800),
  issuedAt: z.number().int(),
  signature,
});
const signalBody = z.object({ caller: identity, signal: signalInputSchema, issuedAt: z.number().int(), signature, commitTx: txHash, commitSender: account });
const accessBody = z.object({ tx: txHash, sender: account });

export interface SignalsDeps {
  sql: Sql;
  viewer: Pick<Viewer, "rpc">;
  deployment: Pick<Deployment, "contracts" | "treasury">;
  /** The secret viewing keys derive from (SIGNALS_SECRET); null leaves signals off. */
  secret: Uint8Array | null;
  signedIn: MiddlewareHandler<{ Variables: { user: string; token: string } }>;
  /** The market's mark on the trading network, stamped on each signal as the price copies are held to. */
  mark: (market: string) => Promise<number | null>;
  now?: () => number;
}

interface ChannelRow {
  leader: string;
  handle: string | null;
  account: string | null;
  price_usdc: string;
  period_days: number;
  reveal_delay_sec: number;
}

interface SignalRow {
  id: string;
  leader: string;
  handle: string | null;
  commitment: string;
  signature: string;
  epoch: number;
  iv: string;
  ciphertext: string;
  issued_at: string;
  committed_at: string;
  commit_tx: string;
  reveal_at: string;
}

const verifies = (message: string, sig: string, id: string) => {
  try {
    return ed25519.verify(new Uint8Array(Buffer.from(sig, "base64")), new TextEncoder().encode(message), new Uint8Array(Buffer.from(id, "hex")));
  } catch {
    return false;
  }
};

/** The weeks whose keys an access window opens: every epoch it overlaps, up to now. */
export function epochsBetween(fromSec: number, toSec: number): number[] {
  const out: number[] = [];
  for (let e = epochOf(fromSec); e <= epochOf(toSec); e++) out.push(e);
  return out;
}

export function signalsRoutes(d: SignalsDeps) {
  const now = d.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const app = new Hono<{ Variables: { user: string; token: string } }>();
  const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  const off = { error: "signals are not configured on this server" } as const;

  const channel = async (leader: string) =>
    (
      await d.sql<ChannelRow[]>`
        SELECT s.leader, c.handle, c.linked_account AS account, s.price_usdc::text, s.period_days, s.reveal_delay_sec
          FROM signal_channels s JOIN callers c ON c.address = s.leader WHERE s.leader = ${leader}`
    )[0] ?? null;

  const feedItem = async (r: SignalRow, revealUpTo: number) => {
    const revealAt = Number(r.reveal_at);
    let signal: Signal | null = null;
    if (revealAt <= revealUpTo && d.secret) signal = await openSignal(await viewingKey(d.secret, r.leader, r.epoch), { iv: r.iv, ciphertext: r.ciphertext }, r.commitment).catch(() => null);
    return {
      id: Number(r.id),
      leader: r.leader,
      handle: r.handle,
      epoch: r.epoch,
      iv: r.iv,
      ciphertext: r.ciphertext,
      commitment: r.commitment,
      signature: r.signature,
      commitTx: r.commit_tx,
      issuedAt: Number(r.issued_at),
      committedAt: Number(r.committed_at),
      revealAt,
      signal,
    };
  };

  // Channels: a leader's price, period and delay, signed by its caller key; the leader must be linked to an account it is paid to.
  app.put("/signals/channel", async (c) => {
    if (!d.secret) return c.json(off, 503);
    const b = channelBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    if (Math.abs(nowSec() - b.data.issuedAt) > SIGNED_WINDOW_SEC || !verifies(channelMessage(b.data), b.data.signature, b.data.caller)) return c.json({ error: "bad or expired signature" }, 401);
    const linked = await d.sql<{ linked_account: string | null }[]>`SELECT linked_account FROM callers WHERE address = ${b.data.caller}`;
    if (!linked[0]?.linked_account) return c.json({ error: "link this identity to your account first: signals are paid to it and committed from it" }, 409);
    if (BigInt(b.data.priceUsdc) <= 0n) return c.json({ error: "the price must be above zero" }, 400);
    await d.sql`
      INSERT INTO signal_channels (leader, price_usdc, period_days, reveal_delay_sec) VALUES (${b.data.caller}, ${b.data.priceUsdc}, ${b.data.periodDays}, ${b.data.revealDelaySec})
      ON CONFLICT (leader) DO UPDATE SET price_usdc = EXCLUDED.price_usdc, period_days = EXCLUDED.period_days, reveal_delay_sec = EXCLUDED.reveal_delay_sec, updated_at = now()`;
    return c.json({ channel: await channel(b.data.caller) });
  });

  app.get("/signals/channels", async (c) => {
    if (!d.secret) return c.json(off, 503);
    const rows = await d.sql<(ChannelRow & { signals: number; last: string | null })[]>`
      SELECT s.leader, c.handle, c.linked_account AS account, s.price_usdc::text, s.period_days, s.reveal_delay_sec,
             count(g.id) FILTER (WHERE g.hidden_at IS NULL)::int AS signals, max(g.issued_at)::text AS last
        FROM signal_channels s JOIN callers c ON c.address = s.leader LEFT JOIN signals g ON g.leader = s.leader
       GROUP BY s.leader, c.handle, c.linked_account ORDER BY max(g.issued_at) DESC NULLS LAST LIMIT 100`;
    return c.json({ channels: rows.map((r) => ({ ...r, leaderId: signalLeader(r.leader), last: r.last === null ? null : Number(r.last) })) });
  });

  // A signal: the caller signs it, its account commits its hash on chain, then the API stamps the mark and seals it.
  app.post("/signals", async (c) => {
    if (!d.secret) return c.json(off, 503);
    const b = signalBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const ch = await channel(b.data.caller);
    if (!ch?.account) return c.json({ error: "open a signals channel first" }, 409);
    const s = b.data.signal;
    const fields = { kind: s.kind, market: s.market, side: s.side, marginUsdc: s.kind === "open" ? s.marginUsdc! : null, leverage: s.kind === "open" ? s.leverage! : null, note: s.note ?? "", issuedAt: b.data.issuedAt };
    if (Math.abs(nowSec() - fields.issuedAt) > SIGNED_WINDOW_SEC || !verifies(await signalMessage(b.data.caller, fields), b.data.signature, b.data.caller)) return c.json({ error: "bad or expired signature" }, 401);
    const today = await d.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM signals WHERE leader = ${b.data.caller} AND issued_at > ${nowSec() - 86_400}`;
    if ((today[0]?.n ?? 0) >= MAX_SIGNALS_PER_DAY) return c.json({ error: `at most ${MAX_SIGNALS_PER_DAY} signals a day` }, 429);
    const commitment = await signalCommitment(b.data.caller, fields);
    let transfers;
    try {
      transfers = await usdcTransfers(d.viewer, d.deployment.contracts.usdc, b.data.commitTx, b.data.commitSender);
    } catch (e) {
      return c.json({ error: `could not read the commitment transaction: ${(e as Error).message.slice(0, 120)}` }, 502);
    }
    const commit = findTransfer(transfers, { from: ch.account, to: d.deployment.treasury, min: COMMIT_AMOUNT, memo: COMMIT_MEMO_PREFIX + commitment });
    if (!commit) return c.json({ error: `the commitment transaction is not a transfer from ${ch.account} to ${d.deployment.treasury} with memo ${COMMIT_MEMO_PREFIX}${commitment}` }, 400);
    if (commit.at < fields.issuedAt - 60 || commit.at > fields.issuedAt + COMMIT_WINDOW_SEC) return c.json({ error: "the commitment landed outside the signal's time" }, 400);
    const price = await d.mark(s.market);
    if (!price || !(price > 0)) return c.json({ error: `no mark for ${s.market} right now; try again` }, 503);
    const signal: Signal = { leader: b.data.caller, ...fields, price };
    const epoch = epochOf(fields.issuedAt);
    const box = await sealSignal(await viewingKey(d.secret, b.data.caller, epoch), signal, commitment);
    const revealAt = commit.at + ch.reveal_delay_sec;
    const rows = await d.sql<{ id: string }[]>`
      INSERT INTO signals (leader, commitment, signature, epoch, iv, ciphertext, issued_at, committed_at, commit_tx, reveal_at)
      VALUES (${b.data.caller}, ${commitment}, ${b.data.signature}, ${epoch}, ${box.iv}, ${box.ciphertext}, ${fields.issuedAt}, ${commit.at}, ${b.data.commitTx}, ${revealAt})
      ON CONFLICT DO NOTHING RETURNING id`;
    if (!rows[0]) return c.json({ error: "this signal or its commitment was already taken" }, 409);
    return c.json({ signal: { id: Number(rows[0].id), commitment, commitTx: b.data.commitTx, committedAt: commit.at, revealAt, epoch } }, 201);
  });

  // The feed: every signal, sealed; revealed ones also in the clear. Viewing keys open the rest.
  app.get("/signals", async (c) => {
    if (!d.secret) return c.json(off, 503);
    const leader = c.req.query("leader");
    if (leader !== undefined && !identity.safeParse(leader).success) return c.json({ error: "leader: an identity" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const rows = await d.sql<SignalRow[]>`
      SELECT g.id, g.leader, c.handle, g.commitment, g.signature, g.epoch, g.iv, g.ciphertext, g.issued_at, g.committed_at, g.commit_tx, g.reveal_at
        FROM signals g JOIN callers c ON c.address = g.leader
       WHERE g.hidden_at IS NULL ${leader ? d.sql`AND g.leader = ${leader}` : d.sql``}
       ORDER BY g.issued_at DESC LIMIT ${limit}`;
    const t = nowSec();
    return c.json({ now: t, signals: await Promise.all(rows.map((r) => feedItem(r, t))) });
  });

  // Viewing keys for the signed-in account: the weeks its access covers, or the leader's own.
  app.get("/signals/:leader/keys", d.signedIn, async (c) => {
    if (!d.secret) return c.json(off, 503);
    const leader = c.req.param("leader");
    if (!identity.safeParse(leader).success) return c.json({ error: "leader: an identity" }, 400);
    const ch = await channel(leader);
    if (!ch) return c.json({ error: "no such channel" }, 404);
    const user = c.get("user");
    const t = nowSec();
    let epochs: number[];
    let expiresAt: number | null;
    if (user === ch.account) {
      epochs = epochsBetween(t - LEADER_KEY_WEEKS * 7 * 86_400, t);
      expiresAt = null;
    } else {
      const access = await d.sql<{ starts_at: string; expires_at: string }[]>`SELECT starts_at, expires_at FROM signal_access WHERE buyer = ${user} AND leader = ${leader} AND expires_at > ${t} ORDER BY expires_at DESC`;
      if (access.length === 0) return c.json({ error: "no early access to this channel", priceUsdc: ch.price_usdc, payTo: ch.account }, 402);
      epochs = [...new Set(access.flatMap((a) => epochsBetween(Number(a.starts_at), Math.min(Number(a.expires_at), t))))];
      expiresAt = Math.max(...access.map((a) => Number(a.expires_at)));
    }
    const secret = d.secret;
    return c.json({ leader, expiresAt, keys: await Promise.all(epochs.map(async (epoch) => ({ epoch, key: await viewingKey(secret, leader, epoch) }))) });
  });

  app.get("/signals/:leader/access", d.signedIn, async (c) => {
    if (!d.secret) return c.json(off, 503);
    const leader = c.req.param("leader");
    const rows = await d.sql<{ expires_at: string }[]>`SELECT max(expires_at)::text AS expires_at FROM signal_access WHERE buyer = ${c.get("user")} AND leader = ${leader}`;
    const expiresAt = rows[0]?.expires_at ? Number(rows[0].expires_at) : null;
    return c.json({ leader, expiresAt, active: expiresAt !== null && expiresAt > nowSec() });
  });

  // Early access: the account paid the leader's account the price, with the channel's memo, in a transaction the API reads back.
  app.post("/signals/:leader/access", d.signedIn, async (c) => {
    if (!d.secret) return c.json(off, 503);
    const leader = c.req.param("leader");
    if (!identity.safeParse(leader).success) return c.json({ error: "leader: an identity" }, 400);
    const b = accessBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const ch = await channel(leader);
    if (!ch?.account) return c.json({ error: "no such channel" }, 404);
    const buyer = c.get("user");
    if (buyer === ch.account) return c.json({ error: "a leader reads its own signals without buying" }, 400);
    let transfers;
    try {
      transfers = await usdcTransfers(d.viewer, d.deployment.contracts.usdc, b.data.tx, b.data.sender);
    } catch (e) {
      return c.json({ error: `could not read the payment: ${(e as Error).message.slice(0, 120)}` }, 502);
    }
    const paid = findTransfer(transfers, { from: buyer, to: ch.account, min: BigInt(ch.price_usdc), memo: ACCESS_MEMO_PREFIX + leader });
    if (!paid) return c.json({ error: `the transaction is not a payment of ${ch.price_usdc} USDC units from ${buyer} to ${ch.account} with memo ${ACCESS_MEMO_PREFIX}${leader}` }, 400);
    if (paid.at < nowSec() - 3600) return c.json({ error: "that payment is more than an hour old" }, 400);
    // A renewal starts where the current access ends.
    const current = await d.sql<{ e: string | null }[]>`SELECT max(expires_at)::text AS e FROM signal_access WHERE buyer = ${buyer} AND leader = ${leader}`;
    const startsAt = Math.max(nowSec(), current[0]?.e ? Number(current[0].e) : 0);
    const expiresAt = startsAt + ch.period_days * 86_400;
    const rows = await d.sql<{ id: string }[]>`
      INSERT INTO signal_access (buyer, leader, starts_at, expires_at, amount, payment_tx) VALUES (${buyer}, ${leader}, ${startsAt}, ${expiresAt}, ${paid.amount.toString()}, ${b.data.tx})
      ON CONFLICT (payment_tx) DO NOTHING RETURNING id`;
    if (!rows[0]) return c.json({ error: "this payment was already used" }, 409);
    return c.json({ leader, startsAt, expiresAt }, 201);
  });

  return app;
}

/** What an agent's x402 payment buys: the viewing keys for the channel's next period, paid to the leader's account. */
export async function paidSignalKeys(d: Pick<SignalsDeps, "sql" | "secret">, leader: string, nowSec: number): Promise<{ payTo: string; amount: bigint; periodDays: number; keys: () => Promise<Array<{ epoch: number; key: string }>> } | null> {
  if (!d.secret || !/^[0-9a-f]{64}$/.test(leader)) return null;
  const rows = await d.sql<{ account: string | null; price_usdc: string; period_days: number }[]>`
    SELECT c.linked_account AS account, s.price_usdc::text, s.period_days FROM signal_channels s JOIN callers c ON c.address = s.leader WHERE s.leader = ${leader}`;
  const r = rows[0];
  if (!r?.account) return null;
  const secret = d.secret;
  return {
    payTo: r.account,
    amount: BigInt(r.price_usdc),
    periodDays: r.period_days,
    keys: () => Promise.all(epochsBetween(nowSec, nowSec + r.period_days * 86_400).map(async (epoch) => ({ epoch, key: await viewingKey(secret, leader, epoch) }))),
  };
}

/** A stored signal in the clear, with the week's key (admin moderation reads signals this way). */
export async function openStoredSignal(secret: Uint8Array, s: { leader: string; epoch: number; iv: string; ciphertext: string; commitment: string }): Promise<Signal> {
  return openSignal(await viewingKey(secret, s.leader, s.epoch), { iv: s.iv, ciphertext: s.ciphertext }, s.commitment);
}

/** Whether `follower` holds early access to `leader` (`signals:<identity>`) right now: what copying its signals needs. */
export async function signalAccessActive(sql: Sql, follower: string, leader: string, nowSec: number): Promise<boolean> {
  const id = /^signals:([0-9a-f]{64})$/.exec(leader)?.[1];
  if (!id) return false;
  const rows = await sql`SELECT 1 FROM signal_access WHERE buyer = ${follower} AND leader = ${id} AND expires_at > ${nowSec} LIMIT 1`;
  return rows.length > 0;
}

/** Pauses follows of signal channels whose follower's early access ended; a renewal and a new follow resume copying. */
export async function pauseLapsedSignalFollows(sql: Sql, nowSec: number): Promise<number> {
  const rows = await sql`
    UPDATE follows f SET status = 'paused', status_reason = 'Your early access to these signals ended: renew it to keep copying them.', updated_at = now()
     WHERE f.status = 'active' AND f.leader LIKE 'signals:%'
       AND NOT EXISTS (SELECT 1 FROM signal_access a WHERE a.buyer = f.follower AND 'signals:' || a.leader = f.leader AND a.expires_at > ${nowSec})
     RETURNING f.id`;
  return rows.length;
}
