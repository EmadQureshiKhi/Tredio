import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, type PasskeyAssertion, type Sender, TxError, type Viewer, ownerKeyHex, verifyPasskey } from "@tredio/chain";
import { type ActivationTicket, activationTicketMessage, calls, type Deployment, type OwnerRequest, requestChallenge } from "@tredio/contracts";
import { decodeSignedDelegateAction } from "near-kit";

/**
 * What the relayer pays for, each checked before a transaction goes out:
 *
 * - Creating a passkey account: the backend's activation ticket for exactly this owner key and
 *   account, a valid passkey proof of the first request, and an account that does not exist yet.
 * - Relaying an owner request (`owner_execute`): the account must be a Tredio account and the
 *   passkey proof must verify against its on-chain owner key here first, so a forged request costs
 *   the relayer nothing.
 * - Topping up a session's gas key: an active session of a Tredio account whose gas key fell
 *   below the minimum.
 * - Meta-transactions (NEP-366) from NEAR wallets: function calls to Tredio contracts only, with
 *   the methods the app uses and no more than a yoctoNEAR attached.
 *
 * Budgets live in memory and reset on restart.
 */

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 429 | 502 | 503,
    /** The transaction, once one was signed: the app can follow it even when this request failed. */
    readonly hash?: string,
  ) {
    super(message);
  }
}

/** Counts events in a sliding window. */
export class Window {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly ms: number,
    private readonly now: () => number = Date.now,
  ) {}
  count(key: string): number {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.ms);
    this.hits.set(key, list);
    return list.length;
  }
  add(key: string, n = 1): void {
    const t = this.now();
    const list = this.hits.get(key) ?? [];
    for (let i = 0; i < n; i++) list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.ms)) this.hits.delete(k);
  }
}

export interface Limits {
  accountsPerHour: number;
  accountsPerDay: number;
  ownerCallsPerAccountPerHour: number;
  topupsPerAccountPerDay: number;
  metaPerAccountPerHour: number;
  /** yoctoNEAR the relayer may spend per hour (deposits plus an estimate of gas). */
  nearPerHour: bigint;
}

/** Contract methods a wallet's meta-transaction may call, by contract. */
export function metaAllowlist(d: Deployment): Map<string, Set<string>> {
  const c = d.contracts;
  return new Map([
    [c.usdc, new Set(["ft_transfer_call", "faucet", "storage_deposit"])],
    [c.outcomes, new Set(["redeem_sets", "redeem_winnings", "mt_transfer_call", "storage_deposit"])],
    [c.book, new Set(["place_order", "cancel_order", "batch_update", "withdraw", "storage_deposit"])],
    [c.perps, new Set(["close", "storage_deposit"])],
    [c.curation, new Set(["claim"])],
  ]);
}

/** Gas (in yoctoNEAR at the 0.1 Ggas price) a relayed transaction may burn at most: 300 Tgas. */
const GAS_COST_ESTIMATE = 3n * 10n ** 22n;
const ONE_YOCTO = 1n;

export interface RelayerDeps {
  sender: Sender;
  viewer: Viewer;
  deployment: Deployment;
  /** The backend's ticket key; null accepts sign-ups without one (testnet only). */
  ticketSigner: string | null;
  createDeposit: bigint;
  sessionGasTarget: bigint;
  sessionGasMin: bigint;
  limits: Limits;
  now?: () => number;
}

type SessionView = { label: string; expires_at: number; gas_key: boolean } | null;

export class Relayer {
  private readonly hour: Window;
  private readonly day: Window;
  private readonly C;
  private readonly allow;
  readonly stats = { accounts: 0, ownerCalls: 0, topups: 0, meta: 0, refused: 0, failed: 0, lastError: null as string | null };

  constructor(private readonly d: RelayerDeps) {
    this.hour = new Window(3_600_000, d.now);
    this.day = new Window(86_400_000, d.now);
    this.C = calls(d.deployment);
    this.allow = metaAllowlist(d.deployment);
  }

  private nowSec() {
    return Math.floor((this.d.now ?? Date.now)() / 1000);
  }

  /** Spending against the hourly cap; refuses once it would pass it. */
  private spend(yocto: bigint) {
    const spent = BigInt(this.hour.count("near:milli")) * 10n ** 21n;
    if (spent + yocto > this.d.limits.nearPerHour) throw new RelayError("the relayer has spent its hourly budget; try again in a little while", 429);
    this.hour.add("near:milli", Number(yocto / 10n ** 21n) + 1);
  }

  private async exists(account: string): Promise<boolean> {
    try {
      await this.d.viewer.rpc("query", { request_type: "view_account", finality: "final", account_id: account });
      return true;
    } catch (e) {
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(String((e as Error).message))) return false;
      throw new RelayError("could not read the chain; try again", 503);
    }
  }

  /** The owner key of a Tredio account, or null when `account` is not one (not this factory's derivation of its own key). */
  private async tredioOwner(account: string): Promise<string | null> {
    if (!/^0u[a-z0-9]{50,62}$/.test(account)) return null;
    let ownerKey: string;
    try {
      ownerKey = await this.d.viewer.view<string>(account, "owner_key");
    } catch {
      return null;
    }
    const derived = await this.d.viewer.view<string>(this.d.deployment.contracts.accounts, "account_id_of", { owner_key: ownerKey }).catch(() => null);
    return derived === account ? ownerKey : null;
  }

  private async checkProof(request: string, proof: PasskeyAssertion, ownerKey: string): Promise<OwnerRequest> {
    let parsed: OwnerRequest;
    try {
      parsed = JSON.parse(request) as OwnerRequest;
    } catch {
      throw new RelayError("the request is not JSON", 400);
    }
    if (parsed.network !== this.d.deployment.network) throw new RelayError(`the request is for ${parsed.network}`, 400);
    if (Math.abs(this.nowSec() - parsed.created_at) > 600) throw new RelayError("the request is too old or from the future; check the clock", 400);
    if (!verifyPasskey(proof, await requestChallenge(request), ownerKeyHex(ownerKey))) throw new RelayError("the passkey proof does not match the request", 403);
    return parsed;
  }

  private fail(e: unknown): never {
    this.stats.failed++;
    const message = e instanceof Error ? e.message : String(e);
    this.stats.lastError = message.slice(0, 300);
    if (e instanceof RelayError) throw e;
    throw new RelayError(e instanceof TxError ? `the transaction failed: ${message.slice(0, 200)}` : "the relayer could not send the transaction; try again", 502, e instanceof TxError ? e.hash : undefined);
  }

  /** Creates the universal account of `ownerKey` and runs its first owner request (adding the first session). */
  async createAccount(a: { ownerKey: string; request: string; proof: PasskeyAssertion; ticket: ActivationTicket | null }): Promise<{ account: string; hash: string }> {
    const account = await this.d.viewer.view<string>(this.d.deployment.contracts.accounts, "account_id_of", { owner_key: a.ownerKey }).catch(() => {
      throw new RelayError("could not read the chain; try again", 503);
    });
    if (this.d.ticketSigner) {
      const t = a.ticket;
      if (!t || t.ownerKey !== a.ownerKey || t.account !== account) throw new RelayError("sign up through the app: an activation ticket is required", 403);
      if (t.expiresAt < this.nowSec()) throw new RelayError("the activation ticket expired; try again", 403);
      const message = activationTicketMessage({ network: this.d.deployment.network, ownerKey: t.ownerKey, account: t.account, expiresAt: t.expiresAt });
      const ok = (() => {
        try {
          return ed25519.verify(new Uint8Array(Buffer.from(t.signature, "base64")), message, base58Decode(this.d.ticketSigner.replace(/^ed25519:/, "")));
        } catch {
          return false;
        }
      })();
      if (!ok) throw new RelayError("the activation ticket is not valid", 403);
    }
    const request = await this.checkProof(a.request, a.proof, a.ownerKey);
    if (request.account !== account) throw new RelayError("the first request names another account", 400);
    if (await this.exists(account)) throw new RelayError("this account already exists; sign in with its passkey", 409);
    if (this.hour.count("accounts") >= this.d.limits.accountsPerHour || this.day.count("accounts") >= this.d.limits.accountsPerDay) {
      this.stats.refused++;
      throw new RelayError("Tredio is opening a lot of accounts right now. Try again in a little while.", 429);
    }
    this.spend(this.d.createDeposit + GAS_COST_ESTIMATE);
    this.hour.add("accounts");
    this.day.add("accounts");
    try {
      const r = await this.d.sender.send(this.C.accounts.create(a.ownerKey, this.d.createDeposit.toString(), { request: a.request, proof: a.proof }));
      this.stats.accounts++;
      return { account, hash: r.hash };
    } catch (e) {
      this.fail(e);
    }
  }

  /** Relays a passkey-signed owner request to a Tredio account. */
  async ownerExecute(a: { account: string; request: string; proof: PasskeyAssertion }): Promise<{ hash: string; value: unknown }> {
    const ownerKey = await this.tredioOwner(a.account);
    if (!ownerKey) throw new RelayError("not a Tredio account", 403);
    const request = await this.checkProof(a.request, a.proof, ownerKey);
    if (request.account !== a.account) throw new RelayError("the request names another account", 400);
    const used = await this.d.viewer.view<boolean>(a.account, "nonce_used", { nonce: request.nonce }).catch(() => false);
    if (used) throw new RelayError("this request was already executed", 409);
    if (this.hour.count(`owner:${a.account}`) >= this.d.limits.ownerCallsPerAccountPerHour) {
      this.stats.refused++;
      throw new RelayError("too many account changes this hour; try again later", 429);
    }
    this.spend(GAS_COST_ESTIMATE);
    this.hour.add(`owner:${a.account}`);
    try {
      const r = await this.d.sender.send(this.C.account.ownerExecute(a.account, a.request, a.proof));
      this.stats.ownerCalls++;
      return r;
    } catch (e) {
      this.fail(e);
    }
  }

  /** Tops up an active session's gas key of a Tredio account to the target, when it is below the minimum. */
  async fundSession(a: { account: string; publicKey: string }): Promise<{ hash: string | null; balance: string }> {
    if (!(await this.tredioOwner(a.account))) throw new RelayError("not a Tredio account", 403);
    const session = await this.d.viewer.view<SessionView>(a.account, "session", { public_key: a.publicKey }).catch(() => null);
    if (!session || session.expires_at <= this.nowSec() || !session.gas_key) throw new RelayError("not an active session gas key of this account", 403);
    const key = await this.d.viewer.gasKey(a.account, a.publicKey).catch(() => {
      throw new RelayError("could not read the chain; try again", 503);
    });
    if (!key) throw new RelayError("the session's gas key is not on the account", 409);
    const balance = key.balance;
    if (balance >= this.d.sessionGasMin) return { hash: null, balance: balance.toString() };
    if (this.day.count(`topup:${a.account}`) >= this.d.limits.topupsPerAccountPerDay) {
      this.stats.refused++;
      throw new RelayError("this session was topped up enough today; try again tomorrow", 429);
    }
    const amount = this.d.sessionGasTarget - balance;
    this.spend(amount + GAS_COST_ESTIMATE / 10n);
    this.day.add(`topup:${a.account}`);
    try {
      const o = await this.d.sender.fundGasKey(a.account, a.publicKey, amount);
      this.stats.topups++;
      return { hash: o.transaction?.hash ?? null, balance: this.d.sessionGasTarget.toString() };
    } catch (e) {
      this.fail(e);
    }
  }

  /** Relays a wallet's signed delegate action (NEP-366) to Tredio contracts. */
  async relayMeta(payload: string): Promise<{ hash: string; sender: string }> {
    let sd: ReturnType<typeof decodeSignedDelegateAction>;
    try {
      sd = decodeSignedDelegateAction(payload);
    } catch {
      throw new RelayError("not a signed delegate action", 400);
    }
    const da = sd.signedDelegate.delegateAction;
    const methods = this.allow.get(da.receiverId);
    if (!methods) throw new RelayError(`the relayer pays only for calls to Tredio contracts, not ${da.receiverId}`, 403);
    for (const action of da.actions as Array<Record<string, unknown>>) {
      const fc = action.functionCall as { methodName: string; deposit: bigint | string } | undefined;
      // Borsh-decoded: the method name is a string, the deposit a bigint.
      if (!fc) throw new RelayError("only function calls are relayed", 403);
      if (!methods.has(fc.methodName)) throw new RelayError(`the relayer does not pay for ${fc.methodName}`, 403);
      const deposit = BigInt(fc.deposit);
      if (deposit > ONE_YOCTO && fc.methodName !== "storage_deposit") throw new RelayError("relayed calls attach at most one yoctoNEAR", 403);
      if (fc.methodName === "storage_deposit" && deposit > 0n) throw new RelayError("pay storage from the wallet", 403);
    }
    if (this.hour.count(`meta:${da.senderId}`) >= this.d.limits.metaPerAccountPerHour) {
      this.stats.refused++;
      throw new RelayError("too many relayed transactions this hour; try again later", 429);
    }
    this.spend(GAS_COST_ESTIMATE);
    this.hour.add(`meta:${da.senderId}`);
    try {
      const o = await this.d.sender.sendTx((tx) => tx.signedDelegateAction(sd));
      this.stats.meta++;
      return { hash: o.transaction?.hash ?? "", sender: da.senderId };
    } catch (e) {
      this.fail(e);
    }
  }
}
