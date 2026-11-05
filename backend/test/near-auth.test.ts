import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { activationTicketMessage, ownerApprovalDigest, ownerRequests } from "@tredio/contracts";
import { Hono } from "hono";
import { ADMIN_RECIPIENT, adminAuth, adminMessage } from "../src/api/admin-auth";
import { type KeyPermission, base58Encode, nep413Hash, ownerKeyHex, verifyNep413Signature, verifyPasskey } from "../src/api/near-auth";
import { OwnerApprovalError, OwnerApprovals } from "../src/api/owner-approval";
import { AccountKeys, SIGN_IN_RECIPIENT, SignInError, signInMessage } from "../src/api/user-auth";
import { ActivationTickets, TicketError } from "../src/activation/tickets";
import type { Sql } from "../src/db";

const NOW = 1_793_900_000;

/** An ed25519 key as NEAR writes it, and a NEP-413 signer for it. */
function nearKey(seed = ed25519.utils.randomSecretKey()) {
  const publicKey = `ed25519:${base58Encode(ed25519.getPublicKey(seed))}`;
  const sign = (message: string, recipient: string) => {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const signature = Buffer.from(ed25519.sign(nep413Hash({ message, nonce, recipient }), seed)).toString("base64");
    return { nonce, signature };
  };
  return { seed, publicKey, sign };
}

/** A WebAuthn-shaped P-256 passkey. */
function passkey() {
  const secret = p256.utils.randomSecretKey();
  const ownerKey = `p256:${base58Encode(p256.getPublicKey(secret, true))}`;
  const assert = (challenge: Uint8Array, flags = 0x05) => {
    const client = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(challenge).toString("base64url"), origin: "https://app.tredio.bid" });
    const auth = new Uint8Array([...sha256(new TextEncoder().encode("tredio.bid")), flags, 0, 0, 0, 1]);
    const msg = new Uint8Array([...auth, ...sha256(new TextEncoder().encode(client))]);
    const sig = p256.sign(sha256(msg), secret, { prehash: false, lowS: true });
    return { authenticator_data: Buffer.from(auth).toString("base64url"), client_data_json: client, signature: Buffer.from(sig).toString("hex") };
  };
  return { ownerKey, assert };
}

describe("NEP-413", () => {
  test("verifies a signed message and refuses another recipient or message", () => {
    const k = nearKey();
    const { nonce, signature } = k.sign("hello", "tredio.bid");
    const proof = { accountId: "alice.testnet", publicKey: k.publicKey, signature, nonce, recipient: "tredio.bid", message: "hello" };
    expect(verifyNep413Signature(proof)).toBe(true);
    expect(verifyNep413Signature({ ...proof, recipient: "admin.tredio.bid" })).toBe(false);
    expect(verifyNep413Signature({ ...proof, message: "hello!" })).toBe(false);
    expect(verifyNep413Signature({ ...proof, publicKey: nearKey().publicKey })).toBe(false);
  });
});

describe("passkey assertions", () => {
  test("verify against the owner key, with user presence and the exact challenge", () => {
    const pk = passkey();
    const challenge = sha256(new TextEncoder().encode("request"));
    expect(verifyPasskey(pk.assert(challenge), challenge, ownerKeyHex(pk.ownerKey))).toBe(true);
    expect(verifyPasskey(pk.assert(challenge), sha256(new TextEncoder().encode("other")), ownerKeyHex(pk.ownerKey))).toBe(false);
    expect(verifyPasskey(pk.assert(challenge, 0x04), challenge, ownerKeyHex(pk.ownerKey))).toBe(false);
    expect(verifyPasskey(pk.assert(challenge), challenge, ownerKeyHex(passkey().ownerKey))).toBe(false);
  });
});

describe("account sign-in", () => {
  const account = "0uaccount";
  const session = nearKey();
  const wallet = nearKey();
  const keys = (opts: { expiresAt?: number; grant?: boolean } = {}) =>
    new AccountKeys(
      async (_a, pk): Promise<KeyPermission | null> =>
        pk === wallet.publicKey ? { kind: "full" } : pk === session.publicKey ? { kind: "function_call", receiverId: account, methodNames: ["session_call"], gasKey: true } : null,
      async (_a, pk) => (pk === session.publicKey ? { label: "app", expires_at: opts.expiresAt ?? NOW + 3600, scope: { outcomes: true, perps: true, hyperliquid: true }, daily_limit: "1" } : null),
      async () => opts.grant ?? false,
      30_000,
      () => NOW * 1000,
    );
  const body = (k: ReturnType<typeof nearKey>, issuedAt = NOW) => ({ account, signer: k.publicKey, issuedAt, ...k.sign(signInMessage(account, k.publicKey, issuedAt), SIGN_IN_RECIPIENT) });

  test("a session key signs in until its session ends; a full-access key for the token's life", async () => {
    expect(await keys().verify(body(session), NOW)).toEqual({ account, signer: session.publicKey, expiresAt: NOW + 3600 });
    expect((await keys().verify(body(wallet), NOW)).expiresAt).toBe(NOW + 12 * 3600);
  });

  test("refuses stale sign-ins, expired sessions, unknown keys and Autopilot's key", async () => {
    await expect(keys().verify(body(session, NOW - 600), NOW)).rejects.toBeInstanceOf(SignInError);
    await expect(keys({ expiresAt: NOW - 1 }).verify(body(session), NOW)).rejects.toThrow(/not an active session/);
    await expect(keys().verify(body(nearKey()), NOW)).rejects.toThrow(/not an active session/);
    await expect(keys({ grant: true }).verify(body(session), NOW)).rejects.toThrow(/Autopilot/);
    const forged = { ...body(session), signer: wallet.publicKey };
    await expect(keys().verify(forged, NOW)).rejects.toThrow(/bad signature/);
  });
});

describe("admin requests", () => {
  const admin = nearKey();
  const app = (perm: KeyPermission | null) => {
    const a = new Hono<{ Variables: { admin: string; token: string | null } }>();
    a.use("*", adminAuth(async () => perm, ["ops.testnet"], "s".repeat(32), async () => false, () => NOW * 1000));
    a.get("/x", (c) => c.json({ admin: c.get("admin") }));
    return a;
  };
  const signed = (k = admin, account = "ops.testnet") => {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const message = adminMessage("GET", "/x", NOW, nonce, "");
    const signature = Buffer.from(ed25519.sign(nep413Hash({ message, nonce, recipient: ADMIN_RECIPIENT }), k.seed)).toString("base64");
    return { "x-tredio-account": account, "x-tredio-public-key": k.publicKey, "x-tredio-timestamp": String(NOW), "x-tredio-nonce": nonce, "x-tredio-signature": signature };
  };

  test("an allowlisted account's full-access key passes once", async () => {
    const a = app({ kind: "full" });
    const headers = signed();
    expect(await (await a.request("/x", { headers })).json()).toEqual({ admin: "ops.testnet" });
    expect((await a.request("/x", { headers })).status).toBe(401);
  });

  test("refuses function-call keys and other accounts", async () => {
    expect((await app({ kind: "function_call", receiverId: "x", methodNames: [], gasKey: false }).request("/x", { headers: signed() })).status).toBe(401);
    expect((await app({ kind: "full" }).request("/x", { headers: signed(admin, "someone.testnet") })).status).toBe(401);
  });
});

/** An in-memory stand-in for the two tables these classes use. */
function fakeSql() {
  const approvals = new Map<string, { account: string; action: string; expires_at: number }>();
  const tickets = new Map<string, { ip: string; expires_at: number }>();
  const sql = ((strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?");
    if (q.startsWith("DELETE FROM owner_approvals WHERE expires_at <=")) return [];
    if (q.startsWith("SELECT count(*)::int AS n FROM owner_approvals")) return [{ n: [...approvals.values()].filter((a) => a.account === v[0]).length }];
    if (q.startsWith("INSERT INTO owner_approvals")) return approvals.set(v[0] as string, { account: v[1] as string, action: v[2] as string, expires_at: v[3] as number }), [];
    if (q.startsWith("SELECT account, action, expires_at FROM owner_approvals")) return approvals.has(v[0] as string) ? [approvals.get(v[0] as string)] : [];
    if (q.startsWith("DELETE FROM owner_approvals WHERE nonce")) return approvals.delete(v[0] as string) ? [{ nonce: v[0] }] : [];
    if (q.startsWith("UPDATE activation_tickets")) return tickets.has(v[1] as string) ? [{ account: v[1] }] : [];
    if (q.includes("FROM activation_tickets")) return [{ ipHour: tickets.size, ipDay: tickets.size, hour: tickets.size, day: tickets.size }];
    if (q.startsWith("INSERT INTO activation_tickets")) return tickets.set(v[0] as string, { ip: v[1] as string, expires_at: v[2] as number }), [];
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as Sql;
  return sql;
}

describe("owner approvals", () => {
  test("a passkey approves exactly one request, once", async () => {
    const pk = passkey();
    const approvals = new OwnerApprovals(fakeSql(), async () => pk.ownerKey, "testnet", () => NOW * 1000);
    const request = ownerRequests.follow("0xabc", { mode: "ratio" });
    const challenge = (await approvals.issue("0uacc", "follow"))!;
    const digest = await ownerApprovalDigest({ network: "testnet", account: "0uacc", request, nonce: challenge.nonce, expiresAt: challenge.expiresAt });
    const approval = { nonce: challenge.nonce, ...pk.assert(digest) };
    // Another request, or another account, with the same approval is refused.
    await expect(approvals.verify("0uacc", ownerRequests.follow("0xdef", { mode: "ratio" }), approval)).rejects.toBeInstanceOf(OwnerApprovalError);
    await expect(approvals.verify("0uother", request, approval)).rejects.toBeInstanceOf(OwnerApprovalError);
    await approvals.verify("0uacc", request, approval);
    await expect(approvals.verify("0uacc", request, approval)).rejects.toThrow(/no longer valid/);
  });
});

describe("activation tickets", () => {
  const seed = ed25519.utils.randomSecretKey();
  const secret = `ed25519:${base58Encode(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]))}`;
  const limits = { perIpPerHour: 2, perIpPerDay: 2, perHour: 10, perDay: 10 };

  test("signs the owner key, its account and expiry for a new account, within the caps", async () => {
    const t = new ActivationTickets(fakeSql(), { accountIdOf: async (k) => `0u${k.length}`, exists: async () => false }, secret, "testnet", limits, () => NOW * 1000);
    const ticket = await t.issue("p256:abc", "198.51.100.7");
    const message = activationTicketMessage({ network: "testnet", ownerKey: "p256:abc", account: ticket.account, expiresAt: ticket.expiresAt });
    expect(ed25519.verify(new Uint8Array(Buffer.from(ticket.signature, "base64")), message, ed25519.getPublicKey(seed))).toBe(true);
    expect(t.publicKey).toBe(`ed25519:${base58Encode(ed25519.getPublicKey(seed))}`);
    // Asking again renews the same ticket without counting it twice.
    await t.issue("p256:abc", "198.51.100.7");
    await t.issue("p256:abcd", "198.51.100.7");
    await expect(t.issue("p256:abcde", "198.51.100.7")).rejects.toBeInstanceOf(TicketError);
  });

  test("refuses an account that already exists", async () => {
    const t = new ActivationTickets(fakeSql(), { accountIdOf: async () => "0uabc", exists: async () => true }, secret, "testnet", limits);
    await expect(t.issue("p256:abc", "198.51.100.7")).rejects.toThrow(/already exists/);
  });
});
