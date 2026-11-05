import { ed25519 } from "@noble/curves/ed25519.js";
import { ACTIVATION_TICKET_TTL_SEC, type ActivationTicket, activationTicketMessage } from "@tredio/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { clientIp, rateLimit } from "../api/rate-limit";
import { base58Decode, base58Encode } from "../api/near-auth";
import type { Sql } from "../db";

/**
 * Activation tickets (see @tredio/contracts activation). The relayer pays about 0.4 NEAR to create
 * a passkey account, and fresh passkeys cost nothing to make, so it creates only accounts this API
 * vouched for. A ticket goes to an owner key whose account does not exist yet, and only while the
 * caller's network and everyone together are within the sign-up caps. They are counted in
 * Postgres, so a restart does not reset them. Asking again for the same account (a sign-up retried
 * after a network failure) renews its ticket without counting twice.
 */

export interface TicketLimits {
  perIpPerHour: number;
  perIpPerDay: number;
  perHour: number;
  perDay: number;
}

export class TicketError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 429 | 503,
  ) {
    super(message);
  }
}

/** What the tickets need from the chain: the account an owner key derives to, and whether it exists. */
export interface AccountLookup {
  accountIdOf(ownerKey: string): Promise<string>;
  exists(account: string): Promise<boolean>;
}

/** `ed25519:<base58 of the 64-byte secret>` (or of its 32-byte seed) to the 32-byte seed. */
export function ed25519Seed(secret: string): Uint8Array {
  const raw = base58Decode(secret.replace(/^ed25519:/, ""));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("an ed25519 secret key is 32 or 64 bytes");
  return raw.slice(0, 32);
}

export class ActivationTickets {
  private readonly seed: Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sql: Sql,
    private readonly chain: AccountLookup,
    secretKey: string,
    private readonly network: "testnet" | "mainnet",
    private readonly limits: TicketLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.seed = ed25519Seed(secretKey);
  }

  /** The key the relayer's ACTIVATION_TICKET_SIGNER names (`ed25519:<base58>`). */
  get publicKey(): string {
    return `ed25519:${base58Encode(ed25519.getPublicKey(this.seed))}`;
  }

  /** A ticket for `ownerKey`, asked for from client address `ip`. One at a time, so concurrent requests cannot pass a cap together. */
  issue(ownerKey: string, ip: string): Promise<ActivationTicket> {
    const run = this.queue.then(() => this.issueNow(ownerKey, ip));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async issueNow(ownerKey: string, ip: string): Promise<ActivationTicket> {
    const unavailable = () => {
      throw new TicketError("Could not check the account on chain; try again.", 503);
    };
    const account = await this.chain.accountIdOf(ownerKey).catch(unavailable);
    if (await this.chain.exists(account).catch(unavailable)) throw new TicketError("This account already exists. Sign in with its passkey instead.", 409);
    const expiresAt = Math.floor(this.now() / 1000) + ACTIVATION_TICKET_TTL_SEC;
    const renewed = await this.sql`UPDATE activation_tickets SET expires_at = ${expiresAt} WHERE account = ${account} RETURNING account`;
    if (renewed.length === 0) {
      const [n] = await this.sql<{ ipHour: number; ipDay: number; hour: number; day: number }[]>`
        SELECT count(*) FILTER (WHERE ip = ${ip} AND issued_at > now() - interval '1 hour')::int AS "ipHour",
               count(*) FILTER (WHERE ip = ${ip})::int AS "ipDay",
               count(*) FILTER (WHERE issued_at > now() - interval '1 hour')::int AS "hour",
               count(*)::int AS "day"
        FROM activation_tickets WHERE issued_at > now() - interval '24 hours'`;
      const l = this.limits;
      if (n!.ipHour >= l.perIpPerHour || n!.ipDay >= l.perIpPerDay) {
        throw new TicketError("Too many new accounts from this network for now. Try again later, or sign in with a passkey you already have.", 429);
      }
      if (n!.hour >= l.perHour || n!.day >= l.perDay) throw new TicketError("Tredio is opening a lot of accounts right now. Try again in a little while.", 429);
      await this.sql`INSERT INTO activation_tickets (account, ip, expires_at) VALUES (${account}, ${ip}, ${expiresAt})`;
    }
    const signature = ed25519.sign(activationTicketMessage({ network: this.network, ownerKey, account, expiresAt }), this.seed);
    return { ownerKey, account, expiresAt, signature: Buffer.from(signature).toString("base64") };
  }
}

/**
 * `POST /activation-ticket` with `{ ownerKey }` (`p256:<base58>`, the passkey's compressed key):
 * the app asks during sign-up, between the passkey prompt and the relayer. Without a ticket key
 * the API answers 503 and the app goes on without one (a relayer that needs tickets then refuses).
 */
export function activationTicketRoutes(tickets: ActivationTickets | null, trustedProxyHops: number, now: () => number = Date.now) {
  const app = new Hono();
  const body = z.object({ ownerKey: z.string().regex(/^p256:[1-9A-HJ-NP-Za-km-z]{40,50}$/, "ownerKey must be p256:<base58>") });
  app.post("/activation-ticket", rateLimit(20, 3_600_000, (c) => `tickets:${clientIp(c, trustedProxyHops)}`, now), async (c) => {
    if (!tickets) return c.json({ error: "activation tickets are not configured" }, 503);
    const b = body.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad request" }, 400);
    try {
      return c.json(await tickets.issue(b.data.ownerKey, clientIp(c, trustedProxyHops)));
    } catch (e) {
      if (e instanceof TicketError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  return app;
}
