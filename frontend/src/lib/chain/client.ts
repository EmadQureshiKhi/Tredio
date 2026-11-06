import { RPC_URLS } from "@/lib/config";

/**
 * Reads from NEAR over JSON-RPC, with failover across providers: a rate-limited or failing one
 * hands over to the next, so one provider's limit never stalls the app. Views read the optimistic
 * head, so a trade the app just sent shows at once.
 */

export class RpcError extends Error {
  constructor(
    message: string,
    /** The error's name as the node reports it (UNKNOWN_ACCOUNT, UNKNOWN_ACCESS_KEY, ...). */
    readonly cause_: string | null = null,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** A contract view that ran and failed: the contract's own message, for example "unknown market". */
export class ViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewError";
  }
}

const transient = (e: unknown) => {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return e instanceof TypeError || /fetch|network|timeout|timed out|429|too many|rate limit|deprecated|502|503|504|unavailable|rpc \d+/.test(m);
};

/**
 * Public RPCs limit requests per address, and a browser cannot read a 429 sent without CORS
 * headers (it looks like a network error). So a provider that fails rests for a while, doubling
 * up to half a minute while it keeps failing, and the others take its traffic meanwhile. Identical
 * requests in flight share one answer, and at most a few run at once, so polling screens never
 * burst past a provider's limit.
 */
const MAX_IN_FLIGHT = 4;
const REST_MS = 2_000;
const MAX_REST_MS = 30_000;

const providers = RPC_URLS.map((url) => ({ url, restUntil: 0, strikes: 0 }));
const inFlight = new Map<string, Promise<unknown>>();
const waiting: Array<() => void> = [];
let running = 0;

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Providers in the order to try them: rested ones first (the last good one leads), then the soonest back. */
function order() {
  const now = Date.now();
  const ready = providers.filter((p) => p.restUntil <= now);
  const resting = providers.filter((p) => p.restUntil > now).sort((a, b) => a.restUntil - b.restUntil);
  return [...ready, ...resting];
}

/** The RPC endpoints in the order to use them now (the one answering best first). */
export const rpcOrder = (): string[] => order().map((p) => p.url);

/** Marks an endpoint as failing (a send through it failed at the HTTP level), so the next call starts elsewhere. */
export function rest(url: string) {
  const p = providers.find((x) => x.url === url);
  if (!p) return;
  p.strikes++;
  p.restUntil = Date.now() + Math.min(MAX_REST_MS, REST_MS * 2 ** (p.strikes - 1));
}

/** Passes over every provider before giving up, with a short pause between passes so a burst limit can clear. */
const ROUNDS = 2;
const ROUND_PAUSE_MS = 800;

async function send<T>(body: string, timeoutMs: number): Promise<T> {
  let last: unknown;
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS * (1 + Math.random())));
    for (const p of order()) {
      try {
        const res = await fetch(p.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new RpcError(`rpc ${res.status}`);
        const answer = (await res.json()) as { result?: T; error?: { cause?: { name?: string; info?: unknown }; message?: string; data?: unknown; code?: number } };
        // FastNEAR answers a rate limit with HTTP 200 and a JSON-RPC error (code -429): the provider rests like on an HTTP 429.
        if (answer.error?.code === -429 || /rate limit|deprecated/i.test(answer.error?.message ?? "")) throw new RpcError("rpc 429");
        p.strikes = 0;
        p.restUntil = 0;
        // The provider that answered leads from now on.
        providers.splice(providers.indexOf(p), 1);
        providers.unshift(p);
        if (answer.error) {
          const name = answer.error.cause?.name ?? null;
          throw new RpcError(name ?? answer.error.message ?? "rpc error", name);
        }
        return answer.result as T;
      } catch (e) {
        if (!transient(e)) throw e;
        last = e;
        rest(p.url);
      }
    }
  }
  throw last instanceof Error ? last : new RpcError("NEAR could not be reached");
}

export function rpc<T>(method: string, params: unknown, timeoutMs = 12_000): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "tredio", method, params });
  // Sending a transaction is never shared: each call is its own submission.
  const shareable = method !== "send_tx" && method !== "broadcast_tx_commit" && method !== "broadcast_tx_async";
  const same = shareable ? (inFlight.get(body) as Promise<T> | undefined) : undefined;
  if (same) return same;
  // Waiting on a transaction holds its request open for seconds: it never takes a reading slot.
  const p = method.endsWith("tx_status") || !shareable ? send<T>(body, timeoutMs) : slot(() => send<T>(body, timeoutMs));
  if (shareable) {
    inFlight.set(body, p);
    void p.then(
      () => inFlight.delete(body),
      () => inFlight.delete(body),
    );
  }
  return p;
}

const decoder = new TextDecoder();

/** Calls a view method and returns its JSON answer. */
export async function view<T>(contract: string, method: string, args: object = {}, finality: "optimistic" | "final" = "optimistic"): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality,
    account_id: contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (r.error) throw new ViewError(r.error.replace(/^.*Smart contract panicked: /s, "").replace(/\s+$/, ""));
  const text = decoder.decode(new Uint8Array(r.result ?? []));
  return (text ? JSON.parse(text) : null) as T;
}

export const isUnknownAccount = (e: unknown) => e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message);

/** The account's NEAR (yocto) and storage use, or null when it does not exist. */
export async function accountState(account: string): Promise<{ amount: bigint; locked: bigint; storageUsage: number } | null> {
  try {
    const r = await rpc<{ amount: string; locked: string; storage_usage: number }>("query", { request_type: "view_account", finality: "optimistic", account_id: account });
    return { amount: BigInt(r.amount), locked: BigInt(r.locked), storageUsage: r.storage_usage };
  } catch (e) {
    if (isUnknownAccount(e)) return null;
    throw e;
  }
}

export interface AccessKeyInfo {
  kind: "full" | "function_call";
  /** Gas keys: the key's own prepaid NEAR (yocto) and its nonce lanes. */
  gasKey: { balance: bigint; nonces: number } | null;
  receiverId: string | null;
  methodNames: string[];
}

/** An access key of `account`, or null when the account does not hold it. */
export async function accessKey(account: string, publicKey: string): Promise<AccessKeyInfo | null> {
  let r: { permission: unknown };
  try {
    r = await rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "optimistic", account_id: account, public_key: publicKey });
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return null;
    throw e;
  }
  const p = r.permission;
  if (p === "FullAccess") return { kind: "full", gasKey: null, receiverId: null, methodNames: [] };
  const o = (p ?? {}) as Record<string, { balance?: string; num_nonces?: number; receiver_id?: string; method_names?: string[]; permission?: unknown }>;
  const gas = o.GasKeyFunctionCall ?? o.GasKeyFullAccess;
  const fc = (o.FunctionCall ?? o.GasKeyFunctionCall ?? {}) as { receiver_id?: string; method_names?: string[] };
  return {
    kind: o.GasKeyFullAccess ? "full" : "function_call",
    gasKey: gas?.balance !== undefined ? { balance: BigInt(gas.balance), nonces: gas.num_nonces ?? 1 } : null,
    receiverId: fc.receiver_id ?? null,
    methodNames: fc.method_names ?? [],
  };
}

/** The newest block's height and time. */
export async function head(): Promise<{ height: number; time: number }> {
  const r = await rpc<{ sync_info: { latest_block_height: number; latest_block_time: string } }>("status", []);
  return { height: r.sync_info.latest_block_height, time: Math.floor(Date.parse(r.sync_info.latest_block_time) / 1000) };
}

/** The transaction a receipt belongs to (the indexer records receipts; NearBlocks shows transactions). */
export async function txOfReceipt(receiptId: string): Promise<{ hash: string; sender: string }> {
  const r = await rpc<{ transaction_hash: string; sender_account_id: string }>("EXPERIMENTAL_receipt_to_tx", { receipt_id: receiptId });
  return { hash: r.transaction_hash, sender: r.sender_account_id };
}
