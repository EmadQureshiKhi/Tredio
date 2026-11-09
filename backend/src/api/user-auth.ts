import type { MiddlewareHandler } from "hono";
import { type IsRevoked, issueSession, readSession, tokenHash } from "./admin-auth";
import { type AccessKeyReader, verifyNep413Signature } from "./near-auth";

/**
 * App sign-in. A Tredio account is a NEAR account: a passkey universal account running the
 * Tredio account contract, or any NEAR wallet. The app proves control with a NEP-413 signed
 * message from either a full-access key (a wallet) or the account's active trading session key
 * (a function-call key limited to `session_call`), both checked on chain, so signing in needs no
 * passkey prompt. The answer is a bearer token naming the key that signed, never longer-lived
 * than that session, and every request checks again (cached briefly) that the key is still
 * active, so revoking it on chain ends the token too.
 */

export const SIGN_IN_WINDOW_SEC = 300;
export const USER_SESSION_SEC = 12 * 3600;
/** How long an on-chain answer about a key stands before a request reads it again. */
export const SIGNER_CHECK_TTL_MS = 30_000;
export const SIGN_IN_RECIPIENT = "tredio.bid";

export function signInMessage(account: string, signer: string, issuedAt: number): string {
  return `Tredio sign-in\naccount: ${account}\nkey: ${signer}\nissued: ${issuedAt}`;
}

export class SignInError extends Error {}
/** The chain could not be read; the request may be retried. */
export class ChainUnavailableError extends Error {}

/** A session as the account contract's `session` view returns it (the fields the API reads). */
export interface SessionView {
  label: string;
  expires_at: number;
  scope: { outcomes: boolean; perps: boolean; hyperliquid: boolean };
  daily_limit: string;
  /** A gas key (the account funds its gas) or a plain key (a policy wallet's, or a relayer's). */
  gas_key?: boolean;
}

export type SessionReader = (account: string, publicKey: string) => Promise<SessionView | null>;

async function onChain<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (e) {
    throw new ChainUnavailableError(e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
}

/** Which keys may act for an account in the API, checked on chain. */
export class AccountKeys {
  /** Per account and key: when the chain was read, and until when the key is active (0: not active). */
  private readonly checked = new Map<string, { at: number; activeUntil: number }>();

  constructor(
    private readonly accessKey: AccessKeyReader,
    private readonly session: SessionReader,
    /** True for keys the account granted Autopilot: they belong to the executor. */
    private readonly isGrantKey: (account: string, key: string) => Promise<boolean>,
    private readonly ttlMs = SIGNER_CHECK_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Until when (unix seconds) `signer` may act for `account`: forever-ish for full-access keys, a session's expiry, or 0. */
  private async activeUntil(account: string, signer: string, nowSec: number): Promise<number> {
    const perm = await onChain(this.accessKey(account, signer));
    if (!perm) return 0;
    if (perm.kind === "full") return nowSec + USER_SESSION_SEC;
    if (perm.receiverId !== account || !perm.methodNames.includes("session_call")) return 0;
    const s = await onChain(this.session(account, signer));
    return s && s.expires_at > nowSec ? s.expires_at : 0;
  }

  /**
   * Checks a sign-in (or any `message` the account signed with NEP-413). Returns the account, the
   * signer and when a token for them must expire. Throws SignInError, or ChainUnavailableError
   * when the chain cannot be read.
   */
  async verify(
    body: { account: string; signer: string; issuedAt: number; signature: string; nonce: string },
    nowSec: number,
    message?: string,
  ): Promise<{ account: string; signer: string; expiresAt: number }> {
    const account = body.account.toLowerCase();
    if (!/^[a-z0-9._-]{2,64}$/.test(account) || !body.signer.startsWith("ed25519:")) throw new SignInError("bad account or key");
    if (!Number.isInteger(body.issuedAt) || Math.abs(nowSec - body.issuedAt) > SIGN_IN_WINDOW_SEC) throw new SignInError("sign-in expired; check the clock");
    const ok = verifyNep413Signature({
      accountId: account,
      publicKey: body.signer,
      signature: body.signature,
      nonce: body.nonce,
      recipient: SIGN_IN_RECIPIENT,
      message: message ?? signInMessage(account, body.signer, body.issuedAt),
    });
    if (!ok) throw new SignInError("bad signature");
    if (await this.isGrantKey(account, body.signer)) throw new SignInError("Autopilot's session key cannot sign in");
    const until = await this.activeUntil(account, body.signer, nowSec);
    if (until <= nowSec) throw new SignInError("the key is not an active session or full-access key of this account");
    this.remember(account, body.signer, until);
    return { account, signer: body.signer, expiresAt: Math.min(nowSec + USER_SESSION_SEC, until) };
  }

  /**
   * Whether `signer` may still act for `account`. Answers are cached for `ttlMs`. Throws
   * ChainUnavailableError when the chain cannot be read.
   */
  async stillActive(account: string, signer: string): Promise<boolean> {
    const key = `${account}:${signer}`;
    const t = this.now();
    const hit = this.checked.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.activeUntil * 1000 > t;
    const until = await this.activeUntil(account, signer, Math.floor(t / 1000));
    this.remember(account, signer, until);
    return until * 1000 > t;
  }

  private remember(account: string, signer: string, activeUntil: number): void {
    const t = this.now();
    if (this.checked.size > 10_000) for (const [k, v] of this.checked) if (t - v.at >= this.ttlMs) this.checked.delete(k);
    this.checked.set(`${account}:${signer}`, { at: t, activeUntil });
  }
}

export const issueUserToken = (secret: string, account: string, signer: string, expiresAt: number) => issueSession(secret, account, expiresAt, "user", signer);

/** The account and signing key of a genuine, unexpired user token; null for tokens without a signer. */
export function readUserToken(secret: string, token: string, nowSec: number): { account: string; signer: string; expiresAt: number } | null {
  const s = readSession(secret, token, nowSec, "user");
  return s?.signer ? { account: s.address, signer: s.signer, expiresAt: s.expiresAt } : null;
}

/**
 * Requires `Authorization: Bearer <user token>` whose signing key is still active on the account,
 * and exposes the account as `user`.
 */
export function userAuth(
  secret: string,
  isRevoked: IsRevoked,
  keys: Pick<AccountKeys, "stillActive">,
  now: () => number = Date.now,
): MiddlewareHandler<{ Variables: { user: string; token: string } }> {
  return async (c, next) => {
    const token = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
    const session = token ? readUserToken(secret, token, Math.floor(now() / 1000)) : null;
    if (!token || !session || (await isRevoked(tokenHash(token)))) return c.json({ error: "sign in first" }, 401);
    let active: boolean;
    try {
      active = await keys.stillActive(session.account, session.signer);
    } catch (e) {
      if (e instanceof ChainUnavailableError) return c.json({ error: "could not check your session on chain; try again" }, 503);
      throw e;
    }
    if (!active) return c.json({ error: "the session key that signed in is no longer active; sign in again" }, 401);
    c.set("user", session.account);
    c.set("token", token);
    await next();
  };
}
