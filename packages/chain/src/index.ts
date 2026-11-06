/**
 * NEAR access for Tredio's services.
 *
 * - `viewer(urls)`: read-only calls with failover across RPC providers (FastNEAR first).
 * - `Sender`: one account sending with one key, either a regular access key (serialized) or a
 *   gas key with N nonce lanes, so a keeper, market maker or relayer sends in parallel without
 *   nonce collisions and pays gas from the key's own prepaid balance.
 * - `send(call)`: sends a `@tredio/contracts` call descriptor and returns the decoded result,
 *   failing with the contract's panic message when the transaction or any receipt failed.
 * - `x402Fetch`, `createPaymentPayload`: the paying side of x402's NEAR `exact` scheme (x402.ts).
 */
import type { Call } from "@tredio/contracts";
import { Near } from "near-kit";
import type { FinalExecutionOutcome, PrivateKey, TransactionBuilder } from "near-kit";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, base58Encode } from "./proofs";

export * from "./proofs";
export * from "./x402";

export const DEFAULT_RPCS: Record<"testnet" | "mainnet", string[]> = {
  // Intear's endpoint is slower but takes bursts the others refuse when several services share an address;
  // dRPC replaces rpc.testnet.near.org, which now answers every call with a deprecation error.
  testnet: ["https://test.rpc.fastnear.com", "https://testnet-rpc.intea.rs", "https://near-testnet.drpc.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};

export type Network = "testnet" | "mainnet";

/** True for errors worth retrying on another provider or later (network, rate limit, timeout). */
export function isTransient(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  // FastNEAR answers a rate limit with HTTP 200 and a JSON-RPC error (code -429, "Rate limits exceeded").
  return /fetch failed|network|timeout|timed out|429|too many|rate limit|deprecated|503|502|504|econnreset|socket|unavailable/.test(m);
}

const FAILOVER_ROUNDS = 3;
const FAILOVER_BACKOFF_MS = 500;

/** Read-only access with provider failover. */
export class Viewer {
  private readonly clients: Near[];
  private next = 0;

  constructor(readonly network: Network, readonly urls: string[] = DEFAULT_RPCS[network]) {
    if (!urls.length) throw new Error("no RPC URL");
    this.clients = urls.map((rpcUrl) => new Near({ network: { networkId: network, rpcUrl } }));
  }

  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    return this.failover((i) => this.clients[i]!.view<T>(contractId, method, args) as Promise<T>);
  }

  /**
   * Tries each provider in turn, starting from the last one that worked; when every provider
   * answers with a transient error (a rate limit, a timeout), waits and goes round again, up to
   * three rounds, so a burst from several services on one address delays a read instead of failing it.
   */
  private async failover<T>(attempt: (provider: number) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let round = 0; round < FAILOVER_ROUNDS; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, FAILOVER_BACKOFF_MS * 3 ** (round - 1) * (0.75 + Math.random() / 2)));
      for (let i = 0; i < this.urls.length; i++) {
        const provider = (this.next + i) % this.urls.length;
        try {
          const result = await attempt(provider);
          this.next = provider;
          return result;
        } catch (e) {
          last = e;
          if (!isTransient(e)) throw e;
        }
      }
    }
    throw last;
  }

  /** The network's final block height and time. */
  async head(): Promise<{ height: number; time: number }> {
    const r = await this.rpc<{ sync_info: { latest_block_height: number; latest_block_time: string } }>("status", []);
    return { height: r.sync_info.latest_block_height, time: Math.floor(Date.parse(r.sync_info.latest_block_time) / 1000) };
  }

  /** A gas key's prepaid balance (yoctoNEAR) and nonce lanes, or null when the key is missing or not a gas key. */
  async gasKey(accountId: string, publicKey: string): Promise<{ balance: bigint; nonces: number } | null> {
    let r: { permission: unknown };
    try {
      r = await this.rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(String((e as Error).message))) return null;
      throw e;
    }
    const p = r.permission as Record<string, { balance?: string; num_nonces?: number }> | string;
    const g = typeof p === "object" ? (p.GasKeyFunctionCall ?? p.GasKeyFullAccess) : undefined;
    return g?.balance === undefined ? null : { balance: BigInt(g.balance), nonces: g.num_nonces ?? 1 };
  }

  async balance(accountId: string): Promise<bigint> {
    const r = await this.rpc<{ amount: string }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return BigInt(r.amount);
  }

  async rpc<T>(method: string, params: unknown): Promise<T> {
    return this.failover(async (i) => {
      const res = await fetch(this.urls[i]!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string; code?: number } };
      // A named cause (UNKNOWN_ACCOUNT) is the node's answer; otherwise keep the code, which tells a rate limit (-429) from a refusal.
      if (body.error) throw new Error(body.error.cause?.name ?? `${body.error.message ?? "rpc error"}${body.error.code !== undefined ? ` (${body.error.code})` : ""}`);
      return body.result as T;
    });
  }

}

export interface SenderOptions {
  network: Network;
  accountId: string;
  privateKey: string;
  /** Use the key as a gas key with this many nonce lanes (it must have been added as one). */
  gasKeyLanes?: number;
  rpcUrls?: string[];
}

/** A failed transaction or receipt, with the contract's panic message when there is one. */
export class TxError extends Error {
  constructor(
    message: string,
    readonly hash?: string,
  ) {
    super(message);
    this.name = "TxError";
  }
}

/** The first failure in an outcome (transaction or any receipt), as readable text. */
export function failureOf(o: FinalExecutionOutcome): string | null {
  const read = (status: unknown): string | null => {
    if (!status || typeof status !== "object" || !("Failure" in status)) return null;
    const f = JSON.stringify((status as { Failure: unknown }).Failure);
    const m = /ExecutionError":"([^"]+)"/.exec(f);
    if (m?.[1]) return m[1].replace(/^Smart contract panicked: /, "");
    // Protocol refusals arrive as JSON; the common ones read as a sentence.
    if (/LackBalanceForState/.test(f)) return "the account does not hold enough NEAR for its storage";
    if (/NotEnoughBalance/.test(f)) return "the account does not hold enough NEAR for this";
    if (/GasKeyBalance|NotEnoughGasKeyBalance|InsufficientGasKeyBalance/i.test(f)) return "the gas key's prepaid balance ran low";
    if (/InvalidNonce/.test(f)) return "the key's nonce moved on; send again";
    return f;
  };
  return (
    read(o.status) ??
    (o.receipts_outcome ?? []).map((r) => read(r.outcome.status)).find((x): x is string => x !== null) ??
    null
  );
}

/** The decoded return value of a successful transaction (JSON or raw text), if any. */
export function returnValue<T>(o: FinalExecutionOutcome): T | undefined {
  const s = o.status as { SuccessValue?: string };
  if (!s?.SuccessValue) return undefined;
  const text = Buffer.from(s.SuccessValue, "base64").toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** The public key (`ed25519:<base58>`) of an `ed25519:<base58>` secret key (64-byte secret or 32-byte seed). */
export function publicKeyOf(secret: string): string {
  const raw = base58Decode(secret.replace(/^ed25519:/, ""));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("an ed25519 secret key is 32 or 64 bytes");
  return `ed25519:${base58Encode(ed25519.getPublicKey(raw.slice(0, 32)))}`;
}

export class Sender {
  readonly accountId: string;
  private readonly rpcUrls: string[];
  /** The key this sender signs with. */
  readonly publicKey: string;
  readonly network: Network;
  private readonly near: Near;
  private readonly lanes: number;
  private readonly busy: boolean[];
  private readonly waiters: Array<(lane: number) => void> = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: SenderOptions) {
    this.accountId = o.accountId;
    this.publicKey = publicKeyOf(o.privateKey);
    this.network = o.network;
    this.rpcUrls = o.rpcUrls ?? DEFAULT_RPCS[o.network];
    const rpcUrl = this.rpcUrls[0]!;
    this.near = new Near({
      network: { networkId: o.network, rpcUrl },
      privateKey: o.privateKey as PrivateKey,
      defaultSignerId: o.accountId,
    });
    this.lanes = o.gasKeyLanes ?? 0;
    this.busy = Array.from({ length: this.lanes }, () => false);
  }

  private async lane(): Promise<number> {
    const free = this.busy.indexOf(false);
    if (free >= 0) {
      this.busy[free] = true;
      return free;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(lane: number) {
    const w = this.waiters.shift();
    if (w) w(lane);
    else this.busy[lane] = false;
  }

  /** Sends `call` and returns the outcome, throwing a TxError on any failure. */
  sendOutcome(call: Call, waitUntil: "EXECUTED_OPTIMISTIC" | "FINAL" = "EXECUTED_OPTIMISTIC"): Promise<FinalExecutionOutcome> {
    return this.sendTx(
      (tx) =>
        tx.functionCall(call.receiverId, call.methodName, call.args, {
          gas: `${BigInt(call.gas) / 10n ** 12n} Tgas` as never,
          attachedDeposit: `${call.deposit} yocto` as never,
        }),
      waitUntil,
    );
  }

  /**
   * Sends a transaction `build` fills in (any actions: transfers, gas-key funding, relayed
   * delegate actions), on a free gas-key lane or after the previous transaction of a regular key.
   */
  async sendTx(build: (tx: TransactionBuilder) => TransactionBuilder, waitUntil: "EXECUTED_OPTIMISTIC" | "FINAL" = "EXECUTED_OPTIMISTIC"): Promise<FinalExecutionOutcome> {
    const run = async (lane: number | null) => {
      let tx = build(this.near.transaction(this.accountId));
      if (lane !== null) tx = tx.useGasKey(lane);
      // Signed once: a broadcast that fails in transit is retried with the same bytes elsewhere and
      // confirmed by hash, so a transaction runs at most once and is never reported failed when it ran.
      try {
        await tx.sign();
      } catch (e) {
        throw new TxError(`could not sign: ${String((e as Error).message ?? e)}`);
      }
      const hash = tx.getHash() ?? undefined;
      let o: FinalExecutionOutcome;
      try {
        o = (await tx.send({ waitUntil })) as FinalExecutionOutcome;
      } catch (e) {
        const details = (e as { details?: unknown }).details;
        const message = details ? `${(e as Error).message}: ${JSON.stringify(details)}` : String((e as Error).message ?? e);
        if (!isTransient(e) || !hash) throw new TxError(message, hash);
        const landed = await this.recover(tx.serialize(), hash, waitUntil);
        if (!landed) throw new TxError(message, hash);
        o = landed;
      }
      const failed = failureOf(o);
      if (failed) throw new TxError(failed, o.transaction?.hash ?? hash);
      return o;
    };
    if (this.lanes > 0) {
      const lane = await this.lane();
      try {
        return await run(lane);
      } finally {
        this.release(lane);
      }
    }
    // A regular key: one transaction at a time, so nonces never collide.
    const p = this.chain.then(() => run(null));
    this.chain = p.catch(() => undefined);
    return p;
  }

  /**
   * After a broadcast failed in transit: sends the same signed bytes through the other providers,
   * then looks the hash up for up to half a minute. Null when the transaction is nowhere to be found.
   */
  private async recover(signed: Uint8Array, hash: string, waitUntil: string): Promise<FinalExecutionOutcome | null> {
    const call = async <T>(url: string, method: string, params: unknown): Promise<T> => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string } };
      if (body.error) throw new Error(body.error.cause?.name ?? body.error.message ?? "rpc error");
      return body.result as T;
    };
    const signedB64 = Buffer.from(signed).toString("base64");
    for (const url of this.rpcUrls.slice(1)) {
      try {
        return await call<FinalExecutionOutcome>(url, "send_tx", { signed_tx_base64: signedB64, wait_until: waitUntil });
      } catch {
        // Already known, rate limited or unreachable: the lookup below settles it.
      }
    }
    for (let i = 0; i < 10; i++) {
      for (const url of this.rpcUrls) {
        try {
          return await call<FinalExecutionOutcome>(url, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: this.accountId, wait_until: waitUntil });
        } catch {
          // Not seen there yet.
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }

  /**
   * Moves `yocto` from this account into a gas key of `account` (any account's: the protocol
   * lets anyone fund a gas key, as with a transfer).
   */
  fundGasKey(account: string, publicKey: string, yocto: bigint): Promise<FinalExecutionOutcome> {
    return this.sendTx((tx) => {
      // near-kit points TransferToGasKey at the signer unless a receiver is already set.
      (tx as unknown as { receiverId?: string }).receiverId = account;
      return tx.transferToGasKey(publicKey, `${yocto} yocto` as never);
    });
  }

  async send<T = unknown>(call: Call): Promise<{ hash: string; value: T | undefined }> {
    const o = await this.sendOutcome(call);
    return { hash: o.transaction?.hash ?? o.transaction_outcome?.id ?? "", value: returnValue<T>(o) };
  }

  /** The underlying near-kit client, for actions call descriptors do not cover. */
  get client(): Near {
    return this.near;
  }
}

/** Retries `fn` on transient errors with exponential backoff. */
export async function retry<T>(fn: () => Promise<T>, attempts = 4, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransient(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

/** yoctoNEAR as a decimal NEAR string, without float rounding (up to six decimals). */
export function toNear(yocto: bigint): string {
  const neg = yocto < 0n;
  const v = neg ? -yocto : yocto;
  const whole = v / 10n ** 24n;
  const frac = ((v % 10n ** 24n) / 10n ** 18n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** One account a service sends from, as every Tredio service reports it on /health. */
export interface WalletHealth {
  label: string;
  account: string;
  balance: string | null;
  min: string | null;
  gasKeys: Array<{ publicKey: string; balance: string; nonces: number }>;
}

/** Reads an account's NEAR and its gas keys for a health report; never throws. */
export async function walletHealth(viewer: Viewer, label: string, account: string, opts: { min?: bigint; gasKeys?: readonly string[] } = {}): Promise<WalletHealth> {
  const [balance, keys] = await Promise.all([
    viewer.balance(account).catch(() => null),
    Promise.all((opts.gasKeys ?? []).map(async (pk) => ({ pk, key: await viewer.gasKey(account, pk).catch(() => null) }))),
  ]);
  return {
    label,
    account,
    balance: balance === null ? null : toNear(balance),
    min: opts.min === undefined ? null : toNear(opts.min),
    gasKeys: keys.flatMap(({ pk, key }) => (key ? [{ publicKey: pk, balance: toNear(key.balance), nonces: key.nonces }] : [])),
  };
}

/**
 * A reading served from memory: the first call waits for it, later calls get the last value at
 * once and start a refresh in the background when it is older than `ttlMs`. Health endpoints use
 * it, so a probe never waits on a rate-limited RPC and polling them spends no RPC quota.
 */
export function cached<T>(read: () => Promise<T>, ttlMs = 30_000): () => Promise<T> {
  let last: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  const refresh = () =>
    (inflight ??= read()
      .then((value) => {
        last = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      }));
  return async () => {
    if (!last) return refresh();
    if (Date.now() - last.at >= ttlMs) refresh().catch(() => {});
    return last.value;
  };
}

/** `walletHealth`, cached; a refresh that could not read the balance keeps the last good reading instead of reporting an empty wallet. */
export function walletWatch(viewer: Viewer, label: string, account: string, opts: { min?: bigint; gasKeys?: readonly string[] } = {}, ttlMs = 30_000): () => Promise<WalletHealth> {
  let good: WalletHealth | null = null;
  return cached(async () => {
    const w = await walletHealth(viewer, label, account, opts);
    if (w.balance === null && good) return good;
    good = w;
    return w;
  }, ttlMs);
}
