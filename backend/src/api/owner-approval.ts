import { randomBytes } from "node:crypto";
import { OWNER_ACTIONS, type OwnerApprovalAction, type OwnerApprovalRequest, type OwnerChallenge, ownerApprovalDigest } from "@tredio/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Sql } from "../db";
import { ownerKeyHex, verifyPasskey } from "./near-auth";
import { rateLimit } from "./rate-limit";
import { ChainUnavailableError } from "./user-auth";

/**
 * Owner approvals (see @tredio/contracts owner-approval): following a leader, enabling an Autopilot
 * rule and linking a caller identity keep acting after the session that asked for them is revoked,
 * so a session token alone cannot make them. The app asks for a nonce, the passkey signs the
 * action's digest with it, and the action's route verifies that assertion against the account's
 * on-chain owner key (the P-256 key its account contract stores), then spends the nonce.
 */

/** How long the app has between asking for a nonce and sending the approved request. */
export const OWNER_APPROVAL_SEC = 300;
/** Unspent nonces one account may hold at once. */
export const MAX_OPEN_APPROVALS = 20;

/** The approval is missing, malformed, stale, spent, or not the passkey's for this request. */
export class OwnerApprovalError extends Error {}

const approvalSchema = z.object({
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
  authenticator_data: z.string().min(40).max(2048),
  client_data_json: z.string().min(1).max(4096),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
});

/** Reads an account contract's passkey key (`owner_key`, `p256:<base58>`); null when it has none. */
export type OwnerKeyReader = (account: string) => Promise<string | null>;

/** A refusal for a route to send as is. */
export interface Refusal {
  body: { error: string; code?: "owner_approval" };
  status: 403 | 503;
}

export class OwnerApprovals {
  constructor(
    private readonly sql: Sql,
    private readonly ownerKey: OwnerKeyReader,
    private readonly network: "testnet" | "mainnet",
    private readonly now: () => number = Date.now,
  ) {}

  private nowSec() {
    return Math.floor(this.now() / 1000);
  }

  /** A single-use nonce for `action` on `account`; null while the account holds too many unspent ones. */
  async issue(account: string, action: OwnerApprovalAction): Promise<OwnerChallenge | null> {
    const nowSec = this.nowSec();
    const owner = account.toLowerCase();
    await this.sql`DELETE FROM owner_approvals WHERE expires_at <= ${nowSec}`;
    const open = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM owner_approvals WHERE account = ${owner}`;
    if ((open[0]?.n ?? 0) >= MAX_OPEN_APPROVALS) return null;
    const nonce = randomBytes(32).toString("hex");
    const expiresAt = nowSec + OWNER_APPROVAL_SEC;
    await this.sql`INSERT INTO owner_approvals (nonce, account, action, expires_at) VALUES (${nonce}, ${owner}, ${action}, ${expiresAt})`;
    return { nonce, expiresAt, network: this.network };
  }

  /**
   * Checks that the account's passkey approved `request` with a nonce issued to this account for
   * this action, then spends the nonce. Throws OwnerApprovalError when refused, and
   * ChainUnavailableError when the owner key cannot be read.
   */
  async verify(account: string, request: OwnerApprovalRequest, approval: unknown): Promise<void> {
    if (approval === undefined || approval === null) throw new OwnerApprovalError("approve this with your passkey");
    const a = approvalSchema.safeParse(approval);
    if (!a.success) throw new OwnerApprovalError("the passkey approval is malformed");
    const nonce = a.data.nonce;
    const nowSec = this.nowSec();
    const row = (await this.sql<{ account: string; action: string; expires_at: string }[]>`SELECT account, action, expires_at FROM owner_approvals WHERE nonce = ${nonce}`)[0];
    if (!row) throw new OwnerApprovalError("this passkey approval is no longer valid; try again");
    if (Number(row.expires_at) <= nowSec) throw new OwnerApprovalError("this passkey approval expired; try again");
    if (row.account !== account.toLowerCase() || row.action !== request.action) throw new OwnerApprovalError("the passkey approval does not match this request");
    let owner: string | null;
    try {
      owner = await this.ownerKey(account);
    } catch (e) {
      throw new ChainUnavailableError(e instanceof Error ? e.message.slice(0, 200) : String(e));
    }
    if (!owner) throw new OwnerApprovalError("this account has no passkey on chain");
    const digest = await ownerApprovalDigest({ network: this.network, account, request, nonce, expiresAt: Number(row.expires_at) });
    if (!verifyPasskey(a.data, digest, ownerKeyHex(owner))) throw new OwnerApprovalError("the passkey approval does not match this request");
    // Spent here, so two requests racing with one approval cannot both pass.
    const spent = await this.sql`DELETE FROM owner_approvals WHERE nonce = ${nonce} AND expires_at > ${nowSec} RETURNING nonce`;
    if (spent.length === 0) throw new OwnerApprovalError("this passkey approval is no longer valid; try again");
  }

  /** `verify` for a route: null when approved, otherwise the refusal to send. */
  async check(account: string, request: OwnerApprovalRequest, approval: unknown): Promise<Refusal | null> {
    try {
      await this.verify(account, request, approval);
      return null;
    } catch (e) {
      if (e instanceof OwnerApprovalError) return { body: { error: e.message, code: "owner_approval" }, status: 403 };
      if (e instanceof ChainUnavailableError) return { body: { error: "could not check the account on chain; try again" }, status: 503 };
      throw e;
    }
  }
}

type Vars = { Variables: { user: string; token: string } };

/** POST /owner-approvals: a nonce for the signed-in account to approve one action with its passkey. */
export function ownerApprovalRoutes(approvals: OwnerApprovals, signedIn: MiddlewareHandler<Vars>, now: () => number = Date.now) {
  const app = new Hono<Vars>();
  const perAccount = rateLimit<Vars>(30, 600_000, (c) => `approvals:${c.get("user")}`, now);
  app.post("/owner-approvals", signedIn, perAccount, async (c) => {
    const body = z.object({ action: z.enum(OWNER_ACTIONS) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: `action: one of ${OWNER_ACTIONS.join(", ")}` }, 400);
    const challenge = await approvals.issue(c.get("user"), body.data.action);
    if (!challenge) return c.json({ error: "too many passkey approvals in progress; wait a few minutes" }, 429);
    return c.json(challenge);
  });
  return app;
}
