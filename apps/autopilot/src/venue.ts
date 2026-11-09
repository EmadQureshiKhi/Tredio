import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Side } from "@tredio/autopilot";
import { isTransient, toNear } from "@tredio/chain";
import { PolicyRefusal } from "@tredio/custody";
import { type AccountVersion, type Session, type SessionAction, sessionCallPrepaid } from "@tredio/contracts";
import {
  type AccountState,
  actionHash,
  agentDigest,
  type EvmSignature,
  type ExchangeResponse,
  type HlNetwork,
  type HlOrder,
  type HyperliquidInfo,
  type L1Action,
  leverageAction,
  orderAction,
  type PerpMarket,
  postAction,
} from "@tredio/hyperliquid";
import { classify, SESSION_MAX_LEVERAGE } from "./orders";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

/**
 * A venue is one account trading Hyperliquid through one session key: the Tredio bot's own
 * account, or an account that granted Autopilot a session. Every order is a `session_call` the
 * account contract checks (scope, expiry, the 2% price guard, the 10x leverage cap) before it asks
 * Chain Signatures to sign; the venue takes the signature from the transaction's result and posts
 * exactly the action the contract hashed to Hyperliquid, so nobody between can change it. A grant on
 * a policy wallet sends the same `session_call` signed in the wallet's custody enclave instead.
 */

export interface PlaceOrder {
  market: Pick<PerpMarket, "symbol" | "index">;
  action: "open" | "close" | "reduce";
  /** The position's side (a close of a long sells). */
  side: Side;
  /** The exact order the contract signs (see buildOrder). */
  order: HlOrder;
  /** Openings: the isolated leverage to set first, when the market is not at it already. */
  leverage: number | null;
  /** Hyperliquid nonce, fixed when the order is recorded: a resend is the same action, which Hyperliquid runs at most once. */
  nonce: number;
}

export interface Fill {
  coin: string;
  px: number;
  sz: number;
  side: "B" | "A";
  /** Unix ms. */
  time: number;
  closedPnl: number;
  fee: number;
  oid: number;
  dir: string;
  /** Hyperliquid's liquidation engine took the other side. */
  liquidation: boolean;
}

export type SendResult =
  | { status: "filled"; txHash: string; size: number; price: number; oid: number | null; feeUsdc: number | null; closedPnlUsdc: number | null }
  | { status: "unfilled" | "failed" | "seen"; txHash: string | null; error: string };

/** A refusal before Hyperliquid answered; `retryable` when the same order may go through later. */
export class VenueError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VenueError";
  }
}

export interface Venue {
  readonly owner: string;
  readonly kind: "bot" | "grant";
  /** The session's public key. */
  readonly sessionKey: string;
  /** The policy wallet that signs this venue's session calls in its custody enclave; null when the executor holds the session key. */
  readonly wallet: VenueWallet | null;
  /** Leverage an opening may set from this session (the account contract refuses more). */
  readonly maxLeverage: number;
  /** The account's Hyperliquid address (its Chain Signatures key). */
  address(): Promise<string>;
  /** The account's code version: it decides the order guard's rules and the gas a session call attaches. */
  version(): Promise<AccountVersion>;
  /** Sends `o`; `sent` runs once the account has signed it on chain, before Hyperliquid sees it. */
  send(o: PlaceOrder, sent: (txHash: string) => Promise<void>): Promise<SendResult>;
}

/**
 * A policy wallet: OutLayer custody (testnet) or a NEAR Intents Agent API agent (mainnet) whose
 * enclave signs the session calls, within a policy the account controls and can freeze.
 */
export interface VenueWallet {
  readonly kind: "outlayer" | "agent-api";
  /** The wallet's NEAR account, which sends the session calls and pays their gas. */
  readonly account: string;
  /**
   * Why the wallet cannot sign for the account now, or null. `pause` when the account must act (the
   * wallet's policy is not the account's, or allows more than Autopilot's); a freeze or a wallet
   * low on gas only waits.
   */
  check(): Promise<{ reason: string; pause: boolean } | null>;
}

/** What the venue needs from NEAR. */
export interface SessionChain {
  session(account: string, publicKey: string): Promise<Session | null>;
  /** The session gas key's prepaid balance (yoctoNEAR), or null when the key is gone. */
  gasBalance(account: string, publicKey: string): Promise<bigint | null>;
  /** The account's code version (1 when it has no `version` view, or the read failed). */
  version(account: string): Promise<AccountVersion>;
  /** `session_call` signed by the session key as a gas key, with the gas the account's version needs: the transaction and its return value. */
  sessionCall(action: SessionAction): Promise<{ hash: string; value: unknown }>;
}

/** What the venue needs from Hyperliquid. */
export interface HyperliquidApi {
  accountState(address: string): Promise<AccountState>;
  /** The account's leverage setting for `coin`. */
  leverage(address: string, coin: string): Promise<{ type: "cross" | "isolated"; value: number } | null>;
  fills(address: string): Promise<Fill[]>;
  post(action: L1Action, nonce: number, sig: EvmSignature): Promise<ExchangeResponse>;
}

/** Which sessions a venue trades through: Autopilot's own label and Hyperliquid scope only, unless a check script says otherwise. */
export interface SessionPolicy {
  label: string | null;
  hyperliquidOnly: boolean;
  /** A policy wallet's session: a plain key, since the wallet pays its own gas. Otherwise the session is a gas key the executor holds. */
  plainKey?: boolean;
}

export const AUTOPILOT_LABEL = "autopilot";
export const AUTOPILOT_POLICY: SessionPolicy = { label: AUTOPILOT_LABEL, hyperliquidOnly: true };
/** Autopilot's session for a policy wallet's key. */
export const WALLET_POLICY: SessionPolicy = { ...AUTOPILOT_POLICY, plainKey: true };

/** Why a session cannot trade for Autopilot, or null when it can. */
export function sessionProblem(s: Session | null, nowSec: number, policy: SessionPolicy): string | null {
  if (!s) return "the account has no such session any more";
  if (s.expires_at <= nowSec) return "the session expired";
  if (!s.scope.hyperliquid) return "the session cannot trade Hyperliquid";
  if (policy.hyperliquidOnly && (s.scope.outcomes || s.scope.perps)) return "the session can do more than Hyperliquid orders, so Autopilot does not hold it";
  if (policy.label !== null && s.label !== policy.label) return `the session is labelled ${s.label}, not ${policy.label}`;
  if (policy.plainKey) {
    if (s.gas_key) return "the policy wallet's session is a gas key, not the wallet's own key";
  } else if (!s.gas_key) return "the session key is not a gas key";
  return null;
}

/** The address an EVM signature over `digest` recovers to (lowercase 0x hex). */
export function recoverAddress(digest: Uint8Array, sig: EvmSignature): string {
  const rs = hexToBytes(sig.r.replace(/^0x/, "").padStart(64, "0") + sig.s.replace(/^0x/, "").padStart(64, "0"));
  const point = secp256k1.Signature.fromBytes(rs, "compact")
    .addRecoveryBit(sig.v - 27)
    .recoverPublicKey(digest);
  return `0x${bytesToHex(keccak_256(point.toBytes(false).slice(1)).slice(-20))}`;
}

/** Hyperliquid nonces: milliseconds, strictly increasing within the process. */
export class Nonces {
  private last = 0;
  constructor(private readonly now: () => number = Date.now) {}
  next(): number {
    const n = Math.max(this.now(), this.last + 1);
    this.last = n;
    return n;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Account guard refusals that pass once the oracle posts the next mark (v2 also needs the mark to name the order's asset). */
const WAIT_FOR_MARK = /stale mark|no mark for asset|mark is for another asset/i;

export interface SessionVenueOptions {
  owner: string;
  kind: "bot" | "grant";
  sessionKey: string;
  network: HlNetwork;
  policy: SessionPolicy;
  chain: SessionChain;
  hyperliquid: HyperliquidApi;
  /** The account's Hyperliquid address. */
  addressOf: () => Promise<string>;
  nonces: Nonces;
  /** Tops up the session's gas key (the relayer); the balance it reports. Unused with a policy wallet, which pays its own gas. */
  fund: () => Promise<bigint>;
  /** The policy wallet that signs the session calls (`chain.sessionCall` goes through it). */
  wallet?: VenueWallet;
  /**
   * Ask for a top-up below this balance (yoctoNEAR); below what a session call prepays for its
   * attached gas (0.3 NEAR on v1 account code, 0.15 on v2) the venue refuses to send.
   */
  gasMin: bigint;
  /** How long a session check holds (ms). */
  checkTtlMs?: number;
  /** First wait before posting again after Hyperliquid did not answer (ms), doubling each time. */
  postRetryMs?: number;
  now?: () => number;
}

export class SessionVenue implements Venue {
  readonly owner: string;
  readonly kind: "bot" | "grant";
  readonly sessionKey: string;
  readonly maxLeverage = SESSION_MAX_LEVERAGE;
  readonly wallet: VenueWallet | null;
  /** The relayer's last refusal to top up, for the health report. */
  lastFundError: string | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private addressValue: string | null = null;
  private readonly now: () => number;

  constructor(private readonly o: SessionVenueOptions) {
    this.owner = o.owner.toLowerCase();
    this.kind = o.kind;
    this.sessionKey = o.sessionKey;
    this.wallet = o.wallet ?? null;
    this.now = o.now ?? Date.now;
  }

  async address(): Promise<string> {
    this.addressValue ??= (await this.o.addressOf()).toLowerCase();
    return this.addressValue;
  }

  version(): Promise<AccountVersion> {
    return this.o.chain.version(this.owner);
  }

  /**
   * The session is live on chain and can pay for a call: its gas key, topped up through the relayer
   * when low, or the policy wallet, which must also be the account's, unfrozen and funded.
   */
  async ready(): Promise<void> {
    if (this.now() - this.checkedAt < (this.o.checkTtlMs ?? 10_000)) return;
    const session = await this.o.chain.session(this.owner, this.sessionKey).catch((e: unknown) => {
      throw new VenueError(`could not read the session: ${message(e)}`, true);
    });
    const problem = sessionProblem(session, Math.floor(this.now() / 1000), this.o.policy);
    if (problem) throw new VenueError(problem, false);
    if (this.wallet) {
      const blocked = await this.wallet.check();
      if (blocked) throw new VenueError(blocked.reason, !blocked.pause);
      this.checkedAt = this.now();
      return;
    }
    let balance = await this.o.chain.gasBalance(this.owner, this.sessionKey).catch(() => null);
    if (balance !== null && balance < this.o.gasMin) {
      try {
        balance = await this.o.fund();
        this.lastFundError = null;
      } catch (e) {
        this.lastFundError = message(e);
      }
      const needed = sessionCallPrepaid(await this.version());
      if (balance < needed) {
        throw new VenueError(`the session's gas key holds ${toNear(balance)} NEAR, below the ${toNear(needed)} NEAR a session call prepays${this.lastFundError ? `; the relayer did not top it up: ${this.lastFundError}` : ""}`, true);
      }
    }
    this.checkedAt = this.now();
  }

  async send(o: PlaceOrder, sent: (txHash: string) => Promise<void>): Promise<SendResult> {
    if (o.leverage !== null) {
      const refused = await this.setLeverage(o.market, o.leverage);
      if (refused) return refused;
    }
    await this.ready();
    const address = await this.signer();
    const signed = await this.call({ hl_order: { order: o.order, nonce: o.nonce } });
    await sent(signed.hash);
    const action = orderAction(o.order);
    const r = await this.post(action, o.nonce, this.signature(signed.value, action, o.nonce, address));
    const out = classify(r);
    if (out.status !== "filled") return { status: out.status, txHash: signed.hash, error: out.error };
    const own = out.oid === null ? [] : (await this.o.hyperliquid.fills(address).catch(() => [] as Fill[])).filter((f) => f.oid === out.oid);
    return {
      status: "filled",
      txHash: signed.hash,
      size: out.size,
      price: out.price,
      oid: out.oid,
      feeUsdc: own.length > 0 ? own.reduce((a, f) => a + f.fee, 0) : null,
      closedPnlUsdc: own.length > 0 ? own.reduce((a, f) => a + f.closedPnl, 0) : null,
    };
  }

  /**
   * Sets isolated `leverage` on `market` unless Hyperliquid has it already; the refusal as a
   * failed result, or null once it is set. Leverage changes pass no price guard, only the 10x cap.
   */
  async setLeverage(market: Pick<PerpMarket, "symbol" | "index">, leverage: number): Promise<{ status: "failed"; txHash: string | null; error: string } | null> {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > this.maxLeverage) return { status: "failed", txHash: null, error: `leverage ${leverage} is not a whole number from 1 to ${this.maxLeverage}` };
    await this.ready();
    const address = await this.signer();
    const current = await this.o.hyperliquid.leverage(address, market.symbol).catch(() => null);
    if (current?.type === "isolated" && current.value === leverage) return null;
    const nonce = this.o.nonces.next();
    const signed = await this.call({ hl_leverage: { asset_index: market.index, is_cross: false, leverage, nonce } });
    const action = leverageAction(market.index, false, leverage);
    const r = await this.post(action, nonce, this.signature(signed.value, action, nonce, address));
    if (r.status !== "err") return null;
    // A nonce Hyperliquid has seen means an earlier post of this change landed and only its answer was lost.
    const landed = /nonce/i.test(r.response) && (await this.o.hyperliquid.leverage(address, market.symbol).catch(() => null))?.value === leverage;
    return landed ? null : { status: "failed", txHash: signed.hash, error: `Hyperliquid refused ${leverage}x isolated leverage: ${r.response}` };
  }

  private async signer(): Promise<string> {
    return this.address().catch((e: unknown) => {
      throw new VenueError(`could not derive the account's Hyperliquid address: ${message(e)}`, true);
    });
  }

  private async call(action: SessionAction): Promise<{ hash: string; value: unknown }> {
    try {
      return await this.o.chain.sessionCall(action);
    } catch (e) {
      const m = message(e);
      // A policy wallet's enclave refusing while frozen, busy or rate limited may sign the same call later; its policy refusing never will.
      const later = e instanceof PolicyRefusal && (e.retryable || e.code === "wallet_frozen");
      throw new VenueError(e instanceof PolicyRefusal ? `the policy wallet refused (${e.code}): ${m}` : m, WAIT_FOR_MARK.test(m) || isTransient(e) || later);
    }
  }

  /** The signature from the transaction's result, checked to recover to the account's Hyperliquid address. */
  private signature(value: unknown, action: L1Action, nonce: number, address: string): EvmSignature {
    const v = value as Partial<EvmSignature> | undefined;
    if (!v || typeof v.r !== "string" || typeof v.s !== "string" || typeof v.v !== "number") throw new VenueError("the session call returned no signature", false);
    const sig = { r: v.r, s: v.s, v: v.v };
    let signer: string;
    try {
      signer = recoverAddress(agentDigest(actionHash(action, nonce), this.o.network === "mainnet"), sig);
    } catch (e) {
      throw new VenueError(`the account's signature does not parse: ${message(e)}`, false);
    }
    if (signer !== address) throw new VenueError(`the account's signature recovers to ${signer}, not its Hyperliquid address ${address}`, false);
    return sig;
  }

  /** Posts a signed action, retrying the network a few times; Hyperliquid runs a nonce at most once. */
  private async post(action: L1Action, nonce: number, sig: EvmSignature): Promise<ExchangeResponse> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await this.o.hyperliquid.post(action, nonce, sig);
      } catch (e) {
        last = e;
        if (i < 2) await Bun.sleep((this.o.postRetryMs ?? 500) * 2 ** i);
      }
    }
    throw new VenueError(`Hyperliquid did not answer: ${message(last)}`, true);
  }
}

/** Hyperliquid for venues: the info API of the trading network and its exchange endpoint. */
export function hyperliquidApi(info: HyperliquidInfo, network: HlNetwork, fetchImpl: typeof fetch = fetch): HyperliquidApi {
  return {
    accountState: (address) => info.accountState(address),
    leverage: async (address, coin) => {
      const r = await info.post<{ leverage?: { type?: string; value?: number } }>({ type: "activeAssetData", user: address.toLowerCase(), coin });
      const t = r.leverage?.type;
      return (t === "cross" || t === "isolated") && typeof r.leverage?.value === "number" ? { type: t, value: r.leverage.value } : null;
    },
    fills: async (address) => {
      const rows = await info.post<Array<Record<string, unknown>>>({ type: "userFills", user: address.toLowerCase() });
      return rows.map((f) => ({
        coin: String(f.coin),
        px: Number(f.px),
        sz: Number(f.sz),
        side: f.side === "B" ? ("B" as const) : ("A" as const),
        time: Number(f.time),
        closedPnl: Number(f.closedPnl ?? 0),
        fee: Number(f.fee ?? 0),
        oid: Number(f.oid),
        dir: String(f.dir ?? ""),
        liquidation: (f.liquidation !== undefined && f.liquidation !== null) || /liquidat/i.test(String(f.dir ?? "")),
      }));
    },
    post: (action, nonce, sig) => postAction(network, action, nonce, sig, fetchImpl),
  };
}

/** Tops up a session gas key through the relayer (`POST /v1/sessions/fund`); the balance it reports. */
export function relayerFunding(relayerUrl: string, account: string, publicKey: string, fetchImpl: typeof fetch = fetch): () => Promise<bigint> {
  return async () => {
    const res = await fetchImpl(`${relayerUrl.replace(/\/$/, "")}/v1/sessions/fund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, publicKey }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; balance?: string };
    if (!res.ok || typeof body.balance !== "string") throw new Error(body.error ?? `relayer answered HTTP ${res.status}`);
    return BigInt(body.balance);
  };
}
