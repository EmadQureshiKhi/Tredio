/**
 * What the tools read straight from NEAR, where the truth is: contract views through RPC
 * failover (`@tredio/chain` Viewer), and a transaction index to find the oracle report behind a
 * checkpoint. The index (FastNEAR's transactions API by default) only locates a transaction; its
 * content is then read from RPC itself.
 */

/** Views and raw JSON-RPC; `Viewer` from `@tredio/chain` fits. */
export interface ChainViews {
  view<T>(contractId: string, method: string, args?: object, finality?: "final" | "optimistic"): Promise<T>;
  rpc<T>(method: string, params: unknown): Promise<T>;
}

export interface IndexedTx {
  hash: string;
  signerId: string;
  receiverId: string;
  /** Function calls of the transaction, args as base64. */
  calls: Array<{ methodName: string; args: string }>;
}

/** Transactions sent to an account, newest first, read lazily so a search stops when it finds one. */
export interface TxIndex {
  recent(accountId: string, limit: number): AsyncIterable<IndexedTx>;
}

type AccountTx = { transaction_hash: string; is_real_receiver?: boolean; is_receiver?: boolean };
type RawTx = { transaction: { hash: string; signer_id: string; receiver_id: string; actions: Array<{ FunctionCall?: { method_name: string; args: string } } | string> } };

/** Requests a rate-limited answer is retried, and the wait before the first retry. */
const ATTEMPTS = 4;
const BACKOFF_MS = 1_500;

/**
 * FastNEAR's transactions API (`https://tx.test.fastnear.com`). Without a key it allows about 60
 * requests a minute per address, shared with anything else there (Tredio's indexer uses it too),
 * so a 429 waits and tries again.
 */
export class FastNearTxIndex implements TxIndex {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly backoffMs = BACKOFF_MS,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && attempt < ATTEMPTS) {
        const after = Number(res.headers.get("retry-after") ?? 0) * 1000;
        await new Promise((r) => setTimeout(r, Math.max(after, this.backoffMs * 2 ** (attempt - 1))));
        continue;
      }
      if (!res.ok) throw new Error(`the transaction index (${this.baseUrl}) answered ${res.status}${res.status === 429 ? "; it is rate limited, try again in a minute" : ""}`);
      // Block times are nanosecond integers past what a JSON number keeps: read them as strings.
      return JSON.parse((await res.text()).replace(/"(\w*timestamp)":\s*(\d+)/g, '"$1":"$2"')) as T;
    }
  }

  async *recent(accountId: string, limit: number): AsyncIterable<IndexedTx> {
    const r = await this.post<{ account_txs: AccountTx[] }>("/v0/account", { account_id: accountId, desc: true, limit: Math.min(limit, 200) });
    const hashes = r.account_txs.filter((t) => t.is_real_receiver ?? t.is_receiver ?? true).map((t) => t.transaction_hash);
    for (let i = 0; i < hashes.length; i += 20) {
      const wanted = hashes.slice(i, i + 20);
      const page = await this.post<{ transactions: RawTx[] }>("/v0/transactions", { tx_hashes: wanted });
      // The API answers in its own order; keep the listing's (newest first).
      const byHash = new Map(page.transactions.map((t) => [t.transaction.hash, t]));
      for (const h of wanted) {
        const t = byHash.get(h);
        if (!t) continue;
        yield {
          hash: t.transaction.hash,
          signerId: t.transaction.signer_id,
          receiverId: t.transaction.receiver_id,
          calls: t.transaction.actions.flatMap((a) => (typeof a === "object" && a.FunctionCall ? [{ methodName: a.FunctionCall.method_name, args: a.FunctionCall.args }] : [])),
        };
      }
    }
  }
}
