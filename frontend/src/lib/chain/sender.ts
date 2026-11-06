import type { Call } from "@tredio/contracts";
import { Near, type PrivateKey } from "near-kit";
import { NETWORK } from "@/lib/config";
import { rest, rpc, rpcOrder } from "./client";
import { base64Encode } from "./encoding";
import { failureOf, failureText, hashOf, type Outcome, refusalOf, returnValue, TxFailed } from "./outcome";

/**
 * Sends transactions signed by a session key straight to NEAR. The session key is a gas key with
 * its own prepaid NEAR and several nonce lanes, so trades go out in parallel without colliding and
 * without a relayer: each send takes a free lane, signs with it and waits until every receipt ran.
 * An RPC that cannot serve the send (rate-limited, down, or behind on gas keys) hands it to the
 * next one: the signed transaction is the same bytes everywhere, so it runs at most once.
 */

export interface Sent<T = unknown> {
  hash: string;
  value: T | undefined;
  outcome: Outcome;
}

/** How long to keep asking for a transaction whose receipts are still running (Chain Signatures takes a while). */
const FOLLOW_MS = 150_000;

const isTimeout = (e: unknown) => {
  const name = (e as { name?: string; code?: string })?.name ?? "";
  const code = (e as { code?: string })?.code ?? "";
  return /Timeout/i.test(name) || /TIMEOUT/i.test(code) || /timed? ?out|TIMEOUT_ERROR/i.test(String((e as Error)?.message ?? ""));
};

/**
 * An error from the RPC after the transaction may already have gone out: a timeout, a 5xx from a
 * provider that broadcast it and then gave up waiting, or a dropped connection. The transaction's
 * own hash then says what happened; a refusal before broadcast (a 4xx, an invalid transaction) does not.
 */
const outcomeUnknown = (e: unknown) => isTimeout(e) || /HTTP 5\d\d|Internal Server Error|Bad Gateway|Service Unavailable|fetch failed|Failed to fetch|NetworkError|ECONNRESET|socket hang up/i.test(String((e as Error)?.message ?? e));

/** The contract's own words for a send that failed. */
export function sendFailure(e: unknown): string {
  const x = e as { panic?: string; details?: unknown; data?: unknown; message?: string };
  if (typeof x?.panic === "string" && x.panic) return x.panic.replace(/^Smart contract panicked: /, "");
  if (x?.details) return failureText(x.details);
  const message = String(x?.message ?? e).replace(/[:\s]+$/, "");
  if (providerFailed(e)) return `NEAR's RPC could not take the transaction (${message}), so it did not run. Try again in a moment.`;
  return message;
}

/** Polls a sent transaction until its receipts have run, or the wait ends. */
export async function follow(hash: string, sender: string, until = Date.now() + FOLLOW_MS): Promise<Outcome> {
  let last: unknown;
  while (Date.now() < until) {
    try {
      const o = await rpc<Outcome & { final_execution_status?: string }>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" }, 20_000);
      if (o.final_execution_status === "EXECUTED_OPTIMISTIC" || o.final_execution_status === "EXECUTED" || o.final_execution_status === "FINAL") return o;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new TxFailed(`still running after ${Math.round(FOLLOW_MS / 1000)} seconds${last ? ` (${String((last as Error).message ?? last)})` : ""}; check the explorer`, hash);
}

/** True once the transaction's block is final (two or three blocks after it executed). */
export async function isFinal(hash: string, sender: string): Promise<boolean> {
  const o = await rpc<{ final_execution_status?: string }>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" }).catch(() => null);
  return o?.final_execution_status === "FINAL";
}

/** An RPC that failed the request itself (HTTP status, unreachable), as opposed to judging the transaction. */
const providerFailed = (e: unknown) => (e as { name?: string })?.name === "NetworkError" || e instanceof TypeError || /HTTP \d{3}|fetch failed|Failed to fetch|NetworkError/i.test(String((e as Error)?.message ?? e));

/** Sends signed bytes to one RPC; null when that RPC failed the request (try another). */
async function broadcast(url: string, signed: string): Promise<{ outcome: Outcome } | { error: { cause?: { name?: string }; name?: string; data?: unknown; message?: string } } | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "tredio", method: "send_tx", params: { signed_tx_base64: signed, wait_until: "EXECUTED_OPTIMISTIC" } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: Outcome; error?: { cause?: { name?: string }; name?: string; data?: unknown; message?: string } };
    return body.result ? { outcome: body.result } : { error: body.error ?? {} };
  } catch {
    return null;
  }
}

export class GasKeySender {
  private readonly nears = new Map<string, Near>();
  /** The RPC that last signed and sent: tried first, since reads may favour one that cannot send. */
  private sendingVia: string | null = null;
  private readonly busy: boolean[];
  private readonly waiting: Array<(lane: number) => void> = [];

  constructor(
    readonly account: string,
    private readonly secretKey: string,
    lanes = 4,
  ) {
    this.busy = Array.from({ length: lanes }, () => false);
  }

  /** near-kit bound to one RPC (its nonce cache is shared across instances, so switching is safe). */
  private nearAt(url: string): Near {
    let n = this.nears.get(url);
    if (!n) {
      n = new Near({ network: { networkId: NETWORK, rpcUrl: url }, privateKey: this.secretKey as PrivateKey, defaultSignerId: this.account });
      this.nears.set(url, n);
    }
    return n;
  }

  /** Builds and signs `call` on `lane` through the first RPC that can serve the nonce and block lookups. */
  private async sign(call: Call, lane: number) {
    let last: unknown;
    const urls = rpcOrder();
    const via = this.sendingVia;
    for (const url of via && urls.includes(via) ? [via, ...urls.filter((u) => u !== via)] : urls) {
      const tx = this.nearAt(url)
        .transaction(this.account)
        .functionCall(call.receiverId, call.methodName, call.args, {
          gas: `${BigInt(call.gas) / 10n ** 12n} Tgas` as never,
          attachedDeposit: `${call.deposit} yocto` as never,
        })
        .useGasKey(lane);
      try {
        await tx.sign();
        return { tx, url };
      } catch (e) {
        if (!providerFailed(e)) throw e;
        last = e;
        rest(url);
      }
    }
    throw last;
  }

  /**
   * After the RPC that signed refused or lost the send: the same bytes through the others, then
   * the transaction's hash, which says whether any of them ran it.
   */
  private async rebroadcast(signed: string, hash: string, skip: string, original: unknown): Promise<Outcome> {
    for (const url of rpcOrder().filter((u) => u !== skip)) {
      const r = await broadcast(url, signed);
      if (!r) {
        rest(url);
        continue;
      }
      if ("outcome" in r) return r.outcome;
      const cause = r.error.cause?.name ?? r.error.name ?? "";
      // Still running, or already sent by the first RPC: the hash tells.
      if (/TIMEOUT/i.test(cause) || /InvalidNonce|AlreadyProcessed/i.test(JSON.stringify(r.error.data ?? ""))) return follow(hash, this.account);
      throw new TxFailed(failureText(r.error.data ?? r.error.message ?? cause), hash);
    }
    return follow(hash, this.account, Date.now() + 30_000).catch(() => {
      throw original;
    });
  }

  private lane(): Promise<number> {
    const free = this.busy.indexOf(false);
    if (free >= 0) {
      this.busy[free] = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(lane: number) {
    const next = this.waiting.shift();
    if (next) next(lane);
    else this.busy[lane] = false;
  }

  /** Sends `call` on a free lane and resolves once every receipt ran; throws TxFailed with the contract's reason. */
  async send<T = unknown>(call: Call): Promise<Sent<T>> {
    const lane = await this.lane();
    let hash: string | null = null;
    try {
      const { tx, url } = await this.sign(call, lane);
      hash = tx.getHash();
      let outcome: Outcome;
      try {
        outcome = (await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as Outcome;
        this.sendingVia = url;
      } catch (e) {
        if (!hash) throw e;
        if (isTimeout(e)) outcome = await follow(hash, this.account);
        else if (providerFailed(e) || outcomeUnknown(e)) {
          rest(url);
          if (this.sendingVia === url) this.sendingVia = null;
          outcome = await this.rebroadcast(base64Encode(tx.serialize()), hash, url, e);
        } else throw e;
      }
      const failed = failureOf(outcome) ?? refusalOf(outcome);
      const h = hashOf(outcome) || hash || "";
      if (failed) throw new TxFailed(failed, h);
      return { hash: h, value: returnValue<T>(outcome), outcome };
    } catch (e) {
      if (e instanceof TxFailed) throw e;
      throw new TxFailed(sendFailure(e), hash);
    } finally {
      this.release(lane);
    }
  }
}
