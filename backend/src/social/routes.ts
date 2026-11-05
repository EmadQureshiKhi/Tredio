import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ownerRequests } from "@tredio/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { issueSession, tokenHash, verifySession } from "../api/admin-auth";
import type { OwnerApprovals } from "../api/owner-approval";
import type { ChainReader } from "../chain";
import type { Sql } from "../db";

/**
 * The social layer. A caller is a passkey-derived ed25519 identity key (its public key as 64 hex
 * characters), separate from the trading account: it signs public calls and thread posts, and
 * nobody can tell which account it belongs to unless the identity signs a link and the account's
 * passkey approves it. Calls resolve from the registry's own checkpoints, so track records are
 * verifiable. The vault holds private data the device sealed with the passkey's vault key; the
 * server only ever sees ciphertext.
 */

export const SIGNED_WINDOW_SEC = 300;
export const HORIZONS = [86_400, 604_800] as const;
export const MAX_CALLS_PER_DAY = 20;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const callMessage = (c: { identifier: string; direction: string; horizonSec: number; note: string; issuedAt: number }) =>
  `Tredio call\ntrend: ${c.identifier}\ndirection: ${c.direction}\nhorizon: ${c.horizonSec}\nnote: ${sha256(c.note)}\nissued: ${c.issuedAt}`;
export const postMessage = (p: { identifier: string; body: string; replyTo: number | null; callId: number | null; issuedAt: number }) =>
  `Tredio post\ntrend: ${p.identifier}\nreply: ${p.replyTo ?? "none"}\ncall: ${p.callId ?? "none"}\nbody: ${sha256(p.body)}\nissued: ${p.issuedAt}`;
export const profileMessage = (p: { handle: string; bio: string; issuedAt: number }) => `Tredio profile\nhandle: ${p.handle}\nbio: ${sha256(p.bio)}\nissued: ${p.issuedAt}`;
export const linkMessage = (identity: string, account: string, issuedAt: number) => `Tredio link\nidentity: ${identity.toLowerCase()}\naccount: ${account.toLowerCase()}\nissued: ${issuedAt}`;
export const identitySignInMessage = (identity: string, issuedAt: number) => `Tredio identity sign-in\nidentity: ${identity.toLowerCase()}\nissued: ${issuedAt}`;

/** An identity: an ed25519 public key as 64 lowercase hex characters. */
const identityId = z.string().regex(/^[0-9a-f]{64}$/, "an identity is a 32-byte ed25519 key in hex");
/** A base64 ed25519 signature (64 bytes). */
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "bad signature");
const signed = { issuedAt: z.number().int(), signature };
/** The identity that signed; its signature must verify against it. */
const claimed = { caller: identityId };
const callBody = z.object({ ...claimed, identifier: z.string().regex(/^[a-z0-9:._-]{1,64}$/), direction: z.enum(["up", "down"]), horizonSec: z.union([z.literal(86_400), z.literal(604_800)]), note: z.string().max(280).default(""), ...signed });
const postBody = z.object({ ...claimed, identifier: z.string().regex(/^[a-z0-9:._-]{1,64}$/), body: z.string().trim().min(1).max(500), replyTo: z.number().int().positive().nullable().default(null), callId: z.number().int().positive().nullable().default(null), ...signed });
const profileBody = z.object({ ...claimed, handle: z.string().regex(/^[a-z0-9_]{3,20}$/, "3 to 20 of a-z, 0-9 and _"), bio: z.string().max(160).default(""), ...signed });
const linkBody = z.object({ identity: identityId, account: z.string().regex(/^[a-z0-9._-]{2,64}$/), issuedAt: z.number().int(), identitySignature: signature, approval: z.unknown().optional() });
const vaultBody = z.object({ ciphertext: z.string().min(1).max(65_536).regex(/^[A-Za-z0-9_-]+$/), iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/), version: z.number().int().positive() });

export interface SocialDeps {
  sql: Sql;
  chain: ChainReader;
  /** The account passkey's approval, which linking needs. */
  approvals: Pick<OwnerApprovals, "check">;
  sessionSecret: string;
  isRevoked: (tokenHash: string) => Promise<boolean>;
  now?: () => number;
}

/** Wilson lower bound of the hit rate at 95%: ranks a 9 of 10 caller above a 1 of 1 caller. */
export function wilson(hits: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96;
  const p = hits / total;
  return (p + (z * z) / (2 * total) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / (1 + (z * z) / total);
}

export function socialRoutes(d: SocialDeps) {
  const now = d.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const app = new Hono<{ Variables: { identity: string } }>();
  const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

  /** `identity` when it signed `message` (ed25519 over the UTF-8 text) and the timestamp is fresh. */
  const signer = async (message: string, issuedAt: number, sig: string, identity: string): Promise<string | null> => {
    if (Math.abs(nowSec() - issuedAt) > SIGNED_WINDOW_SEC) return null;
    try {
      return ed25519.verify(new Uint8Array(Buffer.from(sig, "base64")), new TextEncoder().encode(message), new Uint8Array(Buffer.from(identity, "hex"))) ? identity : null;
    } catch {
      return null;
    }
  };
  const ensureCaller = (address: string) => d.sql`INSERT INTO callers (address) VALUES (${address}) ON CONFLICT DO NOTHING`;

  // Calls.
  app.post("/calls", async (c) => {
    const b = callBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const caller = await signer(callMessage(b.data), b.data.issuedAt, b.data.signature, b.data.caller);
    if (!caller) return c.json({ error: "bad or expired signature" }, 401);
    const trend = (await d.chain.trends()).find((t) => t.identifier === b.data.identifier);
    if (!trend || (trend.status !== "Active" && trend.status !== "Cooling")) return c.json({ error: "calls are made on live trends" }, 400);
    const today = await d.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calls WHERE caller = ${caller} AND called_at > ${nowSec() - 86_400}`;
    if ((today[0]?.n ?? 0) >= MAX_CALLS_PER_DAY) return c.json({ error: `at most ${MAX_CALLS_PER_DAY} calls a day` }, 429);
    await ensureCaller(caller);
    const calledAt = nowSec();
    const rows = await d.sql<{ id: string }[]>`
      INSERT INTO calls (caller, identifier, trend_id, direction, horizon_sec, note, signature, called_at, opening_index, resolves_at)
      VALUES (${caller}, ${trend.identifier}, ${trend.id}, ${b.data.direction}, ${b.data.horizonSec}, ${b.data.note || null}, ${b.data.signature}, ${calledAt}, ${trend.index}, ${calledAt + b.data.horizonSec})
      ON CONFLICT (signature) DO NOTHING RETURNING id`;
    if (!rows[0]) return c.json({ error: "this call was already submitted" }, 409);
    return c.json({ call: { id: Number(rows[0].id), caller, identifier: trend.identifier, direction: b.data.direction, horizonSec: b.data.horizonSec, openingIndex: trend.index, calledAt, resolvesAt: calledAt + b.data.horizonSec } }, 201);
  });

  // Thread posts.
  app.post("/posts", async (c) => {
    const b = postBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const caller = await signer(postMessage(b.data), b.data.issuedAt, b.data.signature, b.data.caller);
    if (!caller) return c.json({ error: "bad or expired signature" }, 401);
    if (!(await d.chain.trends()).some((t) => t.identifier === b.data.identifier)) return c.json({ error: "no such trend" }, 404);
    const recent = await d.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM posts WHERE caller = ${caller} AND created_at > now() - interval '1 minute'`;
    if ((recent[0]?.n ?? 0) >= 5) return c.json({ error: "slow down" }, 429);
    await ensureCaller(caller);
    const rows = await d.sql<{ id: string }[]>`
      INSERT INTO posts (caller, identifier, body, reply_to, call_id, signature) VALUES (${caller}, ${b.data.identifier}, ${b.data.body}, ${b.data.replyTo}, ${b.data.callId}, ${b.data.signature})
      ON CONFLICT (signature) DO NOTHING RETURNING id`;
    if (!rows[0]) return c.json({ error: "this post was already submitted" }, 409);
    return c.json({ post: { id: Number(rows[0].id), caller, identifier: b.data.identifier } }, 201);
  });

  app.get("/trends/:identifier/thread", async (c) => {
    const id = c.req.param("identifier").toLowerCase();
    const [posts, calls] = await Promise.all([
      d.sql`
        SELECT p.id, p.caller, cl.handle, p.body, p.reply_to, p.call_id, p.created_at FROM posts p JOIN callers cl ON cl.address = p.caller
         WHERE p.identifier = ${id} ORDER BY p.created_at DESC LIMIT 100`,
      d.sql`
        SELECT c.id, c.caller, cl.handle, c.direction, c.horizon_sec, c.note, c.called_at, c.opening_index, c.resolves_at, c.closing_index, c.outcome
          FROM calls c JOIN callers cl ON cl.address = c.caller WHERE c.identifier = ${id} ORDER BY c.called_at DESC LIMIT 100`,
    ]);
    return c.json({ posts, calls });
  });

  // Profiles and links.
  app.put("/callers/me", async (c) => {
    const b = profileBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const caller = await signer(profileMessage(b.data), b.data.issuedAt, b.data.signature, b.data.caller);
    if (!caller) return c.json({ error: "bad or expired signature" }, 401);
    try {
      await d.sql`
        INSERT INTO callers (address, handle, bio) VALUES (${caller}, ${b.data.handle}, ${b.data.bio || null})
        ON CONFLICT (address) DO UPDATE SET handle = EXCLUDED.handle, bio = EXCLUDED.bio, updated_at = now()`;
    } catch (e) {
      if (e instanceof Error && /unique/i.test(e.message)) return c.json({ error: "that handle is taken" }, 409);
      throw e;
    }
    return c.json({ caller: { address: caller, handle: b.data.handle, bio: b.data.bio } });
  });

  // Linking needs the identity's signature and the account passkey's approval: a link outlives any
  // session, so a session key alone cannot make one.
  app.post("/callers/link", async (c) => {
    const b = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const message = linkMessage(b.data.identity, b.data.account, b.data.issuedAt);
    const identity = await signer(message, b.data.issuedAt, b.data.identitySignature, b.data.identity);
    if (!identity) return c.json({ error: "the identity did not sign this link" }, 401);
    const taken = await d.sql`SELECT 1 FROM callers WHERE linked_account = ${b.data.account} AND address <> ${identity}`;
    if (taken.length > 0) return c.json({ error: "that account is linked to another caller" }, 409);
    const refused = await d.approvals.check(b.data.account, ownerRequests.linkIdentity(identity), b.data.approval);
    if (refused) return c.json(refused.body, refused.status);
    await ensureCaller(identity);
    try {
      await d.sql`UPDATE callers SET linked_account = ${b.data.account}, linked_at = now(), updated_at = now() WHERE address = ${identity}`;
    } catch (e) {
      if (e instanceof Error && /unique/i.test(e.message)) return c.json({ error: "that account is linked to another caller" }, 409);
      throw e;
    }
    return c.json({ caller: identity, linkedAccount: b.data.account });
  });

  app.get("/callers/leaderboard", async (c) => {
    const rows = await d.sql<{ address: string; handle: string | null; linked_account: string | null; hits: number; misses: number; open: number }[]>`
      SELECT cl.address, cl.handle, cl.linked_account,
             count(*) FILTER (WHERE c.outcome = 'hit')::int AS hits,
             count(*) FILTER (WHERE c.outcome = 'miss')::int AS misses,
             count(*) FILTER (WHERE c.outcome = 'open')::int AS open
        FROM callers cl JOIN calls c ON c.caller = cl.address
       GROUP BY cl.address`;
    const ranked = rows
      .map((r) => ({ ...r, resolved: r.hits + r.misses, hitRate: r.hits + r.misses > 0 ? r.hits / (r.hits + r.misses) : 0, score: wilson(r.hits, r.hits + r.misses) }))
      .sort((a, b) => b.score - a.score || b.resolved - a.resolved);
    return c.json({ callers: ranked.slice(0, 100) });
  });

  app.get("/callers/:address", async (c) => {
    const address = c.req.param("address").toLowerCase();
    const profile = (await d.sql`SELECT address, handle, bio, linked_account, created_at FROM callers WHERE address = ${address} OR handle = ${address}`)[0];
    // ?optional=1: no profile yet is an answer, not an error (the app asks this way).
    if (!profile) return c.req.query("optional") === "1" ? c.json({ caller: null }) : c.json({ error: "no such caller" }, 404);
    const calls = await d.sql`
      SELECT id, identifier, direction, horizon_sec, note, called_at, opening_index, resolves_at, closing_index, outcome FROM calls
       WHERE caller = ${profile.address} ORDER BY called_at DESC LIMIT 100`;
    const hits = calls.filter((x) => x.outcome === "hit").length;
    const misses = calls.filter((x) => x.outcome === "miss").length;
    return c.json({ caller: profile, stats: { hits, misses, open: calls.filter((x) => x.outcome === "open").length, hitRate: hits + misses ? hits / (hits + misses) : 0, score: wilson(hits, hits + misses) }, calls });
  });

  // The vault: sign in as the identity, then read and write ciphertext.
  app.post("/identity/session", async (c) => {
    const b = z.object({ identity: identityId, ...signed }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const who = await signer(identitySignInMessage(b.data.identity, b.data.issuedAt), b.data.issuedAt, b.data.signature, b.data.identity);
    if (!who) return c.json({ error: "bad or expired signature" }, 401);
    const expiresAt = nowSec() + 12 * 3600;
    return c.json({ token: issueSession(d.sessionSecret, who, expiresAt, "identity"), identity: who, expiresAt });
  });

  const vault = new Hono<{ Variables: { identity: string } }>();
  vault.use("*", async (c, next) => {
    const token = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
    const who = token ? verifySession(d.sessionSecret, token, nowSec(), "identity") : null;
    if (!token || !who || (await d.isRevoked(tokenHash(token)))) return c.json({ error: "sign in with your identity first" }, 401);
    c.set("identity", who);
    await next();
  });
  vault.get("/", async (c) => {
    const kind = c.req.query("kind");
    const rows = await d.sql`
      SELECT kind, item_id, ciphertext, iv, version, updated_at FROM vault_items
       WHERE owner = ${c.get("identity")} AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null}) ORDER BY updated_at DESC`;
    return c.json({ items: rows });
  });
  vault.put("/:kind/:id", async (c) => {
    const kind = c.req.param("kind");
    const id = c.req.param("id");
    if (kind !== "strategy" && kind !== "note") return c.json({ error: "kind is strategy or note" }, 400);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.json({ error: "bad item id" }, 400);
    const b = vaultBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const count = await d.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_items WHERE owner = ${c.get("identity")}`;
    if ((count[0]?.n ?? 0) >= 200) return c.json({ error: "the vault holds at most 200 items" }, 409);
    // Versions only move forward, so an older device cannot overwrite newer data.
    const rows = await d.sql`
      INSERT INTO vault_items (owner, kind, item_id, ciphertext, iv, version) VALUES (${c.get("identity")}, ${kind}, ${id}, ${b.data.ciphertext}, ${b.data.iv}, ${b.data.version})
      ON CONFLICT (owner, kind, item_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, version = EXCLUDED.version, updated_at = now()
       WHERE vault_items.version < EXCLUDED.version
      RETURNING version`;
    if (!rows[0]) return c.json({ error: "a newer version is stored" }, 409);
    return c.json({ ok: true, version: b.data.version });
  });
  vault.delete("/:kind/:id", async (c) => {
    await d.sql`DELETE FROM vault_items WHERE owner = ${c.get("identity")} AND kind = ${c.req.param("kind")} AND item_id = ${c.req.param("id")}`;
    return c.json({ ok: true });
  });
  app.route("/vault", vault);

  return app;
}

/** Resolves calls whose window ended: the first checkpoint at or after the end, or the last one if the trend retired. */
export async function resolveCalls(sql: Sql, chain: ChainReader, nowSec: number): Promise<{ resolved: number }> {
  const due = await sql<{ id: string; trend_id: string; direction: "up" | "down"; opening_index: number; resolves_at: string }[]>`
    SELECT id, trend_id, direction, opening_index, resolves_at FROM calls WHERE outcome = 'open' AND resolves_at <= ${nowSec} ORDER BY resolves_at LIMIT 200`;
  if (due.length === 0) return { resolved: 0 };
  const trends = new Map((await chain.trends()).map((t) => [t.id, t]));
  let resolved = 0;
  for (const c of due) {
    const after = await sql<{ points: number }[]>`
      SELECT points FROM index_points WHERE trend_id = ${c.trend_id} AND observed_at >= ${c.resolves_at} ORDER BY observed_at LIMIT 1`;
    let closing = after[0]?.points;
    if (closing === undefined) {
      const t = trends.get(c.trend_id);
      // Retired before the end: no later observation can come, so the last one stands.
      if (t?.status !== "Retired") continue;
      const last = await sql<{ points: number }[]>`SELECT points FROM index_points WHERE trend_id = ${c.trend_id} ORDER BY observed_at DESC LIMIT 1`;
      closing = last[0]?.points;
      if (closing === undefined) {
        await sql`UPDATE calls SET outcome = 'void' WHERE id = ${c.id}`;
        resolved++;
        continue;
      }
    }
    // The outcome markets' rule: up wins only above the opening level.
    const hit = c.direction === "up" ? closing > c.opening_index : closing <= c.opening_index;
    await sql`UPDATE calls SET closing_index = ${closing}, outcome = ${hit ? "hit" : "miss"} WHERE id = ${c.id}`;
    resolved++;
  }
  return { resolved };
}
