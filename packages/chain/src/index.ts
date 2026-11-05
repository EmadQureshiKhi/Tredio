/**
 * NEAR access for Tredio's services.
 *
 * - `viewer(urls)`: read-only calls with failover across RPC providers (FastNEAR first).
 * - `Sender`: one account sending with one key, either a regular access key (serialized) or a
 *   gas key with N nonce lanes, so a keeper, market maker or relayer sends in parallel without
 *   nonce collisions and pays gas from the key's own prepaid balance.
 * - `send(call)`: sends a `@tredio/contracts` call descriptor and returns the decoded result,
 *   failing with the contract's panic message when the transaction or any receipt failed.
 */
import type { Call } from "@tredio/contracts";
import { Near } from "near-kit";
import type { FinalExecutionOutcome, PrivateKey } from "near-kit";

export const DEFAULT_RPCS: Record<"testnet" | "mainnet", string[]> = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};

export type Network = "testnet" | "mainnet";

/** True for errors worth retrying on another provider or later (network, rate limit, timeout). */
export function isTransient(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return /fetch failed|network|timeout|timed out|429|too many|503|502|504|econnreset|socket|unavailable/.test(m);
}

/** Read-only access with provider failover. */
export class Viewer {
  private readonly clients: Near[];
  private next = 0;

  constructor(readonly network: Network, readonly urls: string[] = DEFAULT_RPCS[network]) {
    if (!urls.length) throw new Error("no RPC URL");
    this.clients = urls.map((rpcUrl) => new Near({ network: { networkId: network, rpcUrl } }));
  }

  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    let last: unknown;
    for (let i = 0; i < this.clients.length; i++) {
      const c = this.clients[(this.next + i) % this.clients.length]!;
      try {
        return (await c.view<T>(contractId, method, args)) as T;
      } catch (e) {
        last = e;
        if (!isTransient(e)) throw e;
        this.next = (this.next + 1) % this.clients.length;
      }
    }
    throw last;
  }

  /** The network's final block height and time. */
  async head(): Promise<{ height: number; time: number }> {
    const r = await this.rpc<{ sync_info: { latest_block_height: number; latest_block_time: string } }>("status", []);
    return { height: r.sync_info.latest_block_height, time: Date.parse(r.sync_info.latest_block_time) };
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
    let last: unknown;
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[(this.next + i) % this.urls.length]!;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`rpc ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string } };
        if (body.error) throw new Error(body.error.cause?.name ?? body.error.message ?? "rpc error");
        return body.result as T;
      } catch (e) {
        last = e;
        if (!isTransient(e)) throw e;
      }
    }
    throw last;
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
    return m?.[1]?.replace(/^Smart contract panicked: /, "") ?? f;
  };
  return (
    read(o.status) ??
    o.receipts_outcome.map((r) => read(r.outcome.status)).find((x): x is string => x !== null) ??
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

export class Sender {
  readonly accountId: string;
  readonly network: Network;
  private readonly near: Near;
  private readonly lanes: number;
  private readonly busy: boolean[];
  private readonly waiters: Array<(lane: number) => void> = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: SenderOptions) {
    this.accountId = o.accountId;
    this.network = o.network;
    const rpcUrl = (o.rpcUrls ?? DEFAULT_RPCS[o.network])[0]!;
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
  async sendOutcome(call: Call, waitUntil: "EXECUTED_OPTIMISTIC" | "FINAL" = "EXECUTED_OPTIMISTIC"): Promise<FinalExecutionOutcome> {
    const run = async (lane: number | null) => {
      let tx = this.near
        .transaction(this.accountId)
        .functionCall(call.receiverId, call.methodName, call.args, {
          gas: `${BigInt(call.gas) / 10n ** 12n} Tgas` as never,
          attachedDeposit: `${call.deposit} yocto` as never,
        });
      if (lane !== null) tx = tx.useGasKey(lane);
      let o: FinalExecutionOutcome;
      try {
        o = (await tx.send({ waitUntil })) as FinalExecutionOutcome;
      } catch (e) {
        const details = (e as { details?: unknown }).details;
        throw new TxError(details ? `${(e as Error).message}: ${JSON.stringify(details)}` : String((e as Error).message ?? e));
      }
      const failed = failureOf(o);
      if (failed) throw new TxError(failed, o.transaction?.hash);
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

  async send<T = unknown>(call: Call): Promise<{ hash: string; value: T | undefined }> {
    const o = await this.sendOutcome(call);
    return { hash: o.transaction.hash, value: returnValue<T>(o) };
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
