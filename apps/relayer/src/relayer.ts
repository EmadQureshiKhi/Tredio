import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, type PasskeyAssertion, returnValue, type Sender, TxError, type Viewer, ownerKeyHex, verifyPasskey } from "@tredio/chain";
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
 * - Room for a new session key: an owner request that adds a session, on an account whose NEAR
 *   beyond its storage fell below what a key needs (each device and renewal adds one).
 * - Storage at Tredio's own contracts (perps, outcomes, book): a Tredio account's deposit there,
 *   paid at sign-up, covers a few positions; when it runs low the relayer adds to it.
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

/**
 * The part of an owner request's outcome the app reads: every receipt's status and logs, where
 * the contracts log what they did (an order's id) or what they refused and refunded. The app
 * gets it with the answer instead of asking an RPC for the transaction again.
 */
export interface OutcomeSummary {
  status: unknown;
  transaction: { hash: string };
  receipts_outcome: Array<{ id: string; outcome: { status: unknown; logs: string[]; executor_id: string } }>;
}

type Outcome = Awaited<ReturnType<Sender["sendOutcome"]>>;

export function summarize(o: Outcome): OutcomeSummary {
  return {
    status: o.status,
    transaction: { hash: o.transaction?.hash ?? o.transaction_outcome?.id ?? "" },
    receipts_outcome: (o.receipts_outcome ?? []).map((r) => ({ id: r.id, outcome: { status: r.outcome.status, logs: r.outcome.logs ?? [], executor_id: r.outcome.executor_id } })),
  };
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
  /** Gas key fundings a day: per session (its first funding included), and across all of an account's sessions. */
  topupsPerSessionPerDay: number;
  topupsPerAccountPerDay: number;
  storageTopupsPerAccountPerDay: number;
  metaPerAccountPerHour: number;
  /** yoctoNEAR the relayer may spend per hour (deposits plus an estimate of gas). */
  nearPerHour: bigint;
}

/** Contract methods a wallet's meta-transaction may call, by contract. */
export function metaAllowlist(d: Deployment): Map<string, Set<string>> {
  const c = d.contracts;
  // #mainnet: USDC is Circle's, which has no faucet; the test token under the root account has one.
  const ownUsdc = c.usdc.endsWith(`.${d.root}`);
  return new Map([
    [c.usdc, new Set(["ft_transfer_call", "storage_deposit", ...(ownUsdc ? ["faucet"] : [])])],
    [c.outcomes, new Set(["redeem_sets", "redeem_winnings", "mt_transfer_call", "storage_deposit"])],
    [c.book, new Set(["place_order", "cancel_order", "batch_update", "withdraw", "storage_deposit"])],
    [c.perps, new Set(["close", "storage_deposit"])],
    [c.curation, new Set(["claim"])],
  ]);
}

/** Gas (in yoctoNEAR at the 0.1 Ggas price) a relayed transaction may burn at most: 300 Tgas. */
const GAS_COST_ESTIMATE = 3n * 10n ** 22n;
/** yoctoNEAR per byte of account storage. */
const STORAGE_PRICE = 10n ** 19n;
/** A Tredio account's storage at a Tredio contract is topped up when below the minimum (an open perp takes about 0.003 NEAR). */
const CONTRACT_STORAGE_MIN = 5n * 10n ** 21n;
const CONTRACT_STORAGE_DEPOSIT = 2n * 10n ** 22n;
const ONE_YOCTO = 1n;
/** Token transfers the relayer pays for, whose receiver must be one of Tredio's contracts. */
const TRANSFER_CALLS = new Set(["ft_transfer_call", "mt_transfer_call"]);

/** The receivers a relayed token transfer may name: the contracts that take tokens. */
export function tokenReceivers(d: Deployment): Set<string> {
  const c = d.contracts;
  return new Set([c.outcomes, c.book, c.perps, c.coins, c.curation]);
}

/** `receiver_id` of a function call's JSON arguments, or null. */
function receiverOf(args: unknown): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(args as Uint8Array)) as { receiver_id?: unknown };
    return typeof parsed.receiver_id === "string" ? parsed.receiver_id : null;
  } catch {
    return null;
  }
}

export interface RelayerDeps {
  sender: Sender;
  viewer: Viewer;
  deployment: Deployment;
  /** The backend's ticket key; null accepts sign-ups without one (testnet only). */
  ticketSigner: string | null;
  createDeposit: bigint;
  sessionGasTarget: bigint;
  sessionGasMin: bigint;
  /** NEAR an account must hold beyond its storage before a session key is added, and what the relayer tops it up to. */
  sessionStorageMin: bigint;
  sessionStorageTarget: bigint;
  limits: Limits;
  now?: () => number;
}

type SessionView = { label: string; expires_at: number; gas_key: boolean } | null;

export class Relayer {
  private readonly hour: Window;
  private readonly day: Window;
  private readonly C;
  private readonly allow;
  private readonly receivers;
  readonly stats = { accounts: 0, ownerCalls: 0, topups: 0, meta: 0, refused: 0, failed: 0, lastError: null as string | null };

  constructor(private readonly d: RelayerDeps) {
    this.hour = new Window(3_600_000, d.now);
    this.day = new Window(86_400_000, d.now);
    this.C = calls(d.deployment);
    this.allow = metaAllowlist(d.deployment);
    this.receivers = tokenReceivers(d.deployment);
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
    // The relayer's own wallet running dry is not the person's failure: say so instead of passing the node's JSON on.
    if (/NotEnoughBalance|NotEnoughBalanceForDeposit/.test(message) && message.includes(this.d.sender.accountId)) throw new RelayError("Tredio's relayer is low on NEAR and is being refilled; try again in a few minutes", 503);
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
  async ownerExecute(a: { account: string; request: string; proof: PasskeyAssertion }): Promise<{ hash: string; value: unknown; outcome: OutcomeSummary }> {
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
    if (request.actions.some((x) => typeof x === "object" && x !== null && "add_session" in x)) await this.fundStorage(a.account);
    try {
      const o = await this.d.sender.sendOutcome(this.C.account.ownerExecute(a.account, a.request, a.proof));
      this.stats.ownerCalls++;
      return { hash: o.transaction?.hash ?? o.transaction_outcome?.id ?? "", value: returnValue(o), outcome: summarize(o) };
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * A session key takes storage on the account, and a passkey account holds only what the relayer
   * gave it at creation: before a request that adds a session, its NEAR beyond storage goes back to
   * the target when it is below the minimum, or the key would fail with LackBalanceForState.
   */
  private async fundStorage(account: string): Promise<void> {
    const state = await this.d.viewer.rpc<{ amount: string; storage_usage: number }>("query", { request_type: "view_account", finality: "final", account_id: account }).catch(() => {
      throw new RelayError("could not read the chain; try again", 503);
    });
    const free = BigInt(state.amount) - BigInt(state.storage_usage) * STORAGE_PRICE;
    if (free >= this.d.sessionStorageMin) return;
    if (this.day.count(`storage:${account}`) >= this.d.limits.storageTopupsPerAccountPerDay) {
      this.stats.refused++;
      throw new RelayError("this account added many sessions today; revoke one in Settings or try again tomorrow", 429);
    }
    const amount = this.d.sessionStorageTarget - free;
    this.spend(amount + GAS_COST_ESTIMATE / 10n);
    this.day.add(`storage:${account}`);
    try {
      await this.d.sender.sendTx((tx) => tx.transfer(account, `${amount} yocto` as never));
      this.stats.topups++;
    } catch (e) {
      this.fail(e);
    }
  }

  /** Adds to a Tredio account's storage deposit at one of Tredio's contracts when what is left would not hold one more position. */
  async fundContractStorage(a: { account: string; contract: string }): Promise<{ hash: string | null; available: string }> {
    const c = this.d.deployment.contracts;
    if (![c.perps, c.outcomes, c.book].includes(a.contract)) throw new RelayError("the relayer adds storage at Tredio's contracts only", 400);
    if (!(await this.tredioOwner(a.account))) throw new RelayError("not a Tredio account", 403);
    const balance = await this.d.viewer.view<{ total: string; available: string } | null>(a.contract, "storage_balance_of", { account_id: a.account }).catch(() => {
      throw new RelayError("could not read the chain; try again", 503);
    });
    const available = BigInt(balance?.available ?? "0");
    if (balance && available >= CONTRACT_STORAGE_MIN) return { hash: null, available: available.toString() };
    if (this.day.count(`contract-storage:${a.account}`) >= this.d.limits.storageTopupsPerAccountPerDay) {
      this.stats.refused++;
      throw new RelayError("this account's storage was topped up enough today; try again tomorrow", 429);
    }
    this.spend(CONTRACT_STORAGE_DEPOSIT + GAS_COST_ESTIMATE / 10n);
    this.day.add(`contract-storage:${a.account}`);
    try {
      const r = await this.d.sender.send({ receiverId: a.contract, methodName: "storage_deposit", args: { account_id: a.account, registration_only: false }, gas: (30n * 10n ** 12n).toString(), deposit: CONTRACT_STORAGE_DEPOSIT.toString() });
      this.stats.topups++;
      return { hash: r.hash, available: (available + CONTRACT_STORAGE_DEPOSIT).toString() };
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
    // Each new device's session gets its first funding even when the account's other sessions were refilled today.
    if (this.day.count(`topup:${a.account}:${a.publicKey}`) >= this.d.limits.topupsPerSessionPerDay) {
      this.stats.refused++;
      throw new RelayError("this session was topped up enough today; try again tomorrow", 429);
    }
    if (this.day.count(`topup:${a.account}`) >= this.d.limits.topupsPerAccountPerDay) {
      this.stats.refused++;
      throw new RelayError("this account's sessions were topped up enough today; try again tomorrow", 429);
    }
    const amount = this.d.sessionGasTarget - balance;
    this.spend(amount + GAS_COST_ESTIMATE / 10n);
    this.day.add(`topup:${a.account}:${a.publicKey}`);
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
      const fc = action.functionCall as { methodName: string; args: Uint8Array; deposit: bigint | string } | undefined;
      // Borsh-decoded: the method name is a string, the arguments bytes, the deposit a bigint.
      if (!fc) throw new RelayError("only function calls are relayed", 403);
      if (!methods.has(fc.methodName)) throw new RelayError(`the relayer does not pay for ${fc.methodName}`, 403);
      // Otherwise any wallet could have the relayer pay to move its tokens anywhere (real USDC on mainnet).
      if (TRANSFER_CALLS.has(fc.methodName) && !this.receivers.has(receiverOf(fc.args) ?? "")) {
        throw new RelayError("the relayer pays only for transfers to Tredio contracts", 403);
      }
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
