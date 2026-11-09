import { open } from "@tredio/autopilot";
import { publicKeyOf, type RpcEndpoints, Sender, type Viewer } from "@tredio/chain";
import { type AccountVersions, calls, type Deployment, type Session, sessionCallTgas } from "@tredio/contracts";
import { nearKeyOf } from "@tredio/custody";
import type { ExecutorDb, GrantRow, Route } from "./db";
import type { Log } from "./log";
import { AUTOPILOT_POLICY, type SessionChain, sessionProblem, type Venue, WALLET_POLICY } from "./venue";
import { credentialProblem, type GrantWallet, type WalletCheck, WalletGate } from "./wallets";

/**
 * Venues per owner: the Tredio bot's own account, and for every other account the session it
 * granted Autopilot. A grant's key reaches the executor only as a box the app sealed to this
 * executor's public key, bound to the account and the key; it is opened here and kept in memory.
 * Grants are re-read every tick and checked on chain, so a revoked or expired session stops
 * trading at once; a replacement key the account asked for takes over as soon as the account has
 * added it on chain (with the backend's checks: Autopilot's label, Hyperliquid scope only, a gas
 * key limited to `session_call`).
 *
 * A grant backed by a policy wallet seals the wallet's credential instead of a session key, and its
 * session is for the wallet's own key: the venue sends every session call through the wallet's
 * custody enclave, and waits while the account has frozen the wallet.
 */

/** An access key's permission, as far as grants care. */
export type KeyPermission = { kind: "full" } | { kind: "function_call"; receiverId: string; methodNames: string[]; gasKey: boolean };

/** What grant checks read on chain. */
export interface GrantChain {
  session(account: string, publicKey: string): Promise<Session | null>;
  accessKey(account: string, publicKey: string): Promise<KeyPermission | null>;
}

export interface VenueRequest {
  owner: string;
  kind: "bot" | "grant";
  /** `ed25519:<base58>` secret of the session key; for a policy wallet, the wallet's credential. */
  secretKey: string;
  sessionKey: string;
  /** The policy wallet that signs instead of a session key the executor holds. */
  wallet?: GrantWallet | null;
}

export type Resolved = { venue: Venue } | { reason: string; pause: boolean };

export interface VenuesOptions {
  /** Opens grants (base64url PKCS#8 P-256). Without it, only the bot trades. */
  sealPrivateKey: string | null;
  bot: { account: string; secretKey: string } | null;
}

/** Why a key is not a session gas key the account limits to its own guarded calls, or null. */
export function grantKeyProblem(owner: string, key: KeyPermission | null): string | null {
  if (!key) return "the key is not on the account";
  if (key.kind !== "function_call" || key.receiverId !== owner || !key.methodNames.includes("session_call")) return "the key is not limited to the account's guarded session calls";
  if (!key.gasKey) return "the key is not a gas key";
  return null;
}

/**
 * Why a policy wallet's key on the account is not one Autopilot's session may have, or null. The
 * enclave signs only as the wallet's own account, so the key need not be on the account at all; if
 * it is, it must be a plain key limited to the account's guarded session calls.
 */
export function walletKeyProblem(owner: string, key: KeyPermission | null): string | null {
  if (!key) return null;
  if (key.kind !== "function_call" || key.receiverId !== owner || !key.methodNames.includes("session_call")) return "the wallet's key is not limited to the account's guarded session calls";
  if (key.gasKey) return "the wallet's key is a gas key";
  return null;
}

export class Venues {
  private grants = new Map<string, GrantRow>();
  private readonly cache = new Map<string, Venue>();
  /** Grants whose box does not open, so it is reported once per key. */
  private readonly broken = new Map<string, string>();
  readonly bot: { account: string; sessionKey: string } | null;

  constructor(
    private readonly db: ExecutorDb,
    private readonly chain: GrantChain,
    private readonly make: (r: VenueRequest) => Venue,
    private readonly opts: VenuesOptions,
    private readonly log: Log,
  ) {
    this.bot = opts.bot ? { account: opts.bot.account.toLowerCase(), sessionKey: publicKeyOf(opts.bot.secretKey) } : null;
  }

  get canOpenGrants(): boolean {
    return this.opts.sealPrivateKey !== null;
  }

  /** Reads every active grant: switches to a waiting key that is on chain, ends expired and revoked ones. */
  async refresh(nowSec: number): Promise<void> {
    const next = new Map<string, GrantRow>();
    for (const g of await this.db.grants()) {
      try {
        const live = await this.usable(g, nowSec);
        if (live) next.set(g.owner, live);
      } catch (e) {
        // A failed read keeps the grant; the account contract refuses a dead session anyway.
        next.set(g.owner, g);
        this.log.warn({ owner: g.owner, err: e instanceof Error ? e.message : String(e) }, "grant check failed");
      }
    }
    this.grants = next;
    for (const key of this.cache.keys()) {
      const [owner, sessionKey] = key.split("|");
      if (owner !== this.bot?.account && next.get(owner!)?.sessionKey !== sessionKey) this.cache.delete(key);
    }
  }

  /** The grant to trade with, or null after ending it as expired, or revoked when its session is gone on chain. */
  private async usable(g: GrantRow, nowSec: number): Promise<GrantRow | null> {
    const current = (g.nextSessionKey ? await this.switchOver(g, g.nextSessionKey, nowSec) : null) ?? g;
    if (current.validUntil <= nowSec) {
      if (await this.db.endGrant(current.owner, current.sessionKey, "expired")) await this.db.audit(current.owner, "grant_expired", { sessionKey: current.sessionKey });
      return null;
    }
    const problem = sessionProblem(await this.chain.session(current.owner, current.sessionKey), nowSec, current.wallet ? WALLET_POLICY : AUTOPILOT_POLICY);
    if (problem) {
      if (await this.db.endGrant(current.owner, current.sessionKey, "revoked")) await this.db.audit(current.owner, "grant_revoked_on_chain", { sessionKey: current.sessionKey, reason: problem });
      this.log.warn({ owner: current.owner, reason: problem }, "grant ended");
      return null;
    }
    return current;
  }

  /** Switches a grant to its waiting key once the account has added it as an Autopilot session; null until then. */
  private async switchOver(g: GrantRow, nextKey: string, nowSec: number): Promise<GrantRow | null> {
    const [session, key] = await Promise.all([this.chain.session(g.owner, nextKey), this.chain.accessKey(g.owner, nextKey)]);
    if (!session) return null;
    const keyProblem = g.nextWallet ? walletKeyProblem(g.owner, key) : grantKeyProblem(g.owner, key);
    if (sessionProblem(session, nowSec, g.nextWallet ? WALLET_POLICY : AUTOPILOT_POLICY) || keyProblem) return null;
    const switched = await this.db.switchGrant(g.owner, nextKey, session.expires_at, BigInt(session.daily_limit));
    if (switched) await this.db.audit(g.owner, "grant_switched", { from: g.sessionKey, sessionKey: switched.sessionKey, validUntil: switched.validUntil, dailyLimit: switched.dailyLimit.toString() });
    return switched;
  }

  /** The bot's venue for its own account, otherwise the account's grant. */
  async forOwner(owner: string, route: Route = "session", nowSec = Math.floor(Date.now() / 1000)): Promise<Resolved> {
    const o = owner.toLowerCase();
    if (this.bot && o === this.bot.account) return { venue: this.botVenue() };
    if (route === "api") return this.bot ? { reason: `the Tredio bot trades from ${this.bot.account}, not ${o}`, pause: true } : { reason: "this executor runs no Tredio bot (AUTOPILOT_BOT_ACCOUNT)", pause: false };
    let g = this.grants.get(o);
    if (!g) {
      // Granted since the last refresh (a rule can be enabled in the same tick as its grant).
      const fresh = await this.db.grant(o);
      const live = fresh ? await this.usable(fresh, nowSec).catch(() => fresh) : null;
      if (!live) return { reason: "no active Autopilot grant for the account", pause: true };
      this.grants.set(o, live);
      g = live;
    }
    if (!this.opts.sealPrivateKey) return { reason: "this executor cannot open grants (AUTOPILOT_SEAL_PRIVATE_KEY is not set)", pause: false };
    const cacheKey = `${o}|${g.sessionKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return this.gated(cached);
    const brokenWhy = this.broken.get(cacheKey);
    if (brokenWhy) return { reason: brokenWhy, pause: true };
    let secret: string;
    try {
      secret = await open(g.sealedKey, this.opts.sealPrivateKey, { owner: o, sessionKey: g.sessionKey });
    } catch (e) {
      return this.markBroken(cacheKey, o, `the grant does not open with this executor's key (${e instanceof Error ? e.message : String(e)}); grant Autopilot again`);
    }
    let venue: Venue;
    if (g.wallet) {
      // The box holds the wallet's credential; the session is for the wallet's own key.
      const wrong = credentialProblem(g.wallet.kind, secret) ?? (nearKeyOf(g.wallet.account) === g.sessionKey ? null : "the grant's session is not for its policy wallet's key");
      if (wrong) return this.markBroken(cacheKey, o, `${wrong}; grant Autopilot again`);
      try {
        venue = this.make({ owner: o, kind: "grant", secretKey: secret, sessionKey: g.sessionKey, wallet: g.wallet });
      } catch (e) {
        // This executor cannot reach the wallet's service (no Agent API key on mainnet): it waits, the grant stands.
        return { reason: e instanceof Error ? e.message : String(e), pause: false };
      }
    } else {
      const secretKey = secret.startsWith("ed25519:") ? secret : `ed25519:${secret}`;
      let key: string | null = null;
      try {
        key = publicKeyOf(secretKey);
      } catch {
        key = null;
      }
      if (key !== g.sessionKey) return this.markBroken(cacheKey, o, "the grant does not open to its session key; grant Autopilot again");
      venue = this.make({ owner: o, kind: "grant", secretKey, sessionKey: g.sessionKey, wallet: null });
    }
    for (const k of this.cache.keys()) if (k.startsWith(`${o}|`)) this.cache.delete(k);
    this.cache.set(cacheKey, venue);
    return this.gated(venue);
  }

  /** A policy wallet's venue only while its wallet can sign: a freeze makes the account's rules and copies wait, a wallet that is not the account's pauses them. */
  private async gated(venue: Venue): Promise<Resolved> {
    const blocked = venue.wallet ? await venue.wallet.check() : null;
    return blocked ?? { venue };
  }

  /** The last check of every policy wallet this executor trades through, for /health. */
  walletChecks(): WalletCheck[] {
    return [...this.cache.values()].flatMap((v) => (v.wallet instanceof WalletGate && v.wallet.last ? [v.wallet.last] : []));
  }

  private async markBroken(cacheKey: string, owner: string, reason: string): Promise<Resolved> {
    this.broken.set(cacheKey, reason);
    await this.db.audit(owner, "grant_unusable", { reason });
    this.log.warn({ owner, reason }, "grant unusable");
    return { reason, pause: true };
  }

  botVenue(): Venue {
    if (!this.bot || !this.opts.bot) throw new Error("no Tredio bot");
    const key = `${this.bot.account}|${this.bot.sessionKey}`;
    let v = this.cache.get(key);
    if (!v) {
      v = this.make({ owner: this.bot.account, kind: "bot", secretKey: this.opts.bot.secretKey, sessionKey: this.bot.sessionKey });
      this.cache.set(key, v);
    }
    return v;
  }
}

/** Grant checks over NEAR RPC: the account's `session` view and the key's permission. */
export function nearGrantChain(viewer: Viewer): GrantChain {
  return {
    session: (account, publicKey) => viewer.view<Session | null>(account, "session", { public_key: publicKey }),
    accessKey: async (account, publicKey) => {
      let r: { permission: unknown };
      try {
        r = await viewer.rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
      } catch (e) {
        if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(String((e as Error).message))) return null;
        throw e;
      }
      const perm = r.permission;
      if (perm === "FullAccess" || (typeof perm === "object" && perm !== null && "GasKeyFullAccess" in perm)) return { kind: "full" };
      const p = perm as Record<string, { receiver_id: string; method_names: string[] } | undefined>;
      const fc = p.FunctionCall ?? p.GasKeyFunctionCall;
      return fc ? { kind: "function_call", receiverId: fc.receiver_id, methodNames: fc.method_names, gasKey: "GasKeyFunctionCall" in p } : null;
    },
  };
}

/**
 * NEAR for one session venue: views through `viewer`, `session_call` from the session key as a
 * gas key with the gas the account's code version needs (300 Tgas on v1, 150 on v2), the version
 * read once per account through `versions` (shared by every venue).
 */
export function nearSessionChain(viewer: Viewer, deployment: Deployment, account: string, secretKey: string, rpc: RpcEndpoints, versions: AccountVersions): SessionChain {
  const sender = new Sender({ network: deployment.network, accountId: account, privateKey: secretKey, gasKeyLanes: 1, rpc });
  const c = calls(deployment);
  return {
    session: (a, publicKey) => viewer.view<Session | null>(a, "session", { public_key: publicKey }),
    gasBalance: async (a, publicKey) => (await viewer.gasKey(a, publicKey))?.balance ?? null,
    version: (a) => versions.of(a),
    sessionCall: async (action) => sender.send(c.account.sessionCall(account, action, sessionCallTgas(await versions.of(account)))),
  };
}
