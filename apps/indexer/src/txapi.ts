/**
 * FastNEAR's transactions API (`https://tx.test.fastnear.com`, `https://tx.main.fastnear.com`;
 * source github.com/fastnear/explorer-api), the `INDEXER_SOURCE=txs` feed.
 *
 * - `/v0/blocks`: the newest blocks the API has committed (it writes a block's row after that
 *   block's transactions and account rows), so its head bounds what the other endpoints know.
 * - `/v0/account`: every transaction that touched an account (signer, receiver or predecessor of
 *   any receipt, or named in an action argument or event), by inclusion height, filtered with
 *   `from_tx_block_height` and `to_tx_block_height` (both inclusive), oldest first with
 *   `desc: false`, 200 a page, `resume_token` for the next page.
 * - `/v0/transactions`: up to 20 transactions by hash, each with every receipt executed so far
 *   (execution outcome with logs, status, executor, block height and time, and its position in
 *   the block). The API rewrites a transaction as its receipts execute.
 * - Without a key the API answers 429 past about 60 requests a minute per IP (measured
 *   2026-11-06), with `Retry-After: 0`.
 */
import { Requester, type RequesterOptions } from "./http";

/** One receipt's execution, as the API returns it (block times as decimal strings, see `parse`). */
export interface TxOutcome {
  id: string;
  block_height: number;
  block_timestamp: string;
  /** Position of the outcome in its block (receipts in shard order, as neardata lists them). */
  index: number;
  outcome: { executor_id: string; logs: string[]; status: unknown; receipt_ids: string[] };
}

export interface TxRecord {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  execution_outcome: TxOutcome;
  receipts: Array<{ receipt: { receipt_id: string; receiver_id: string; predecessor_id: string }; execution_outcome: TxOutcome }>;
}

export interface ApiBlock {
  height: number;
  time: Date;
}

export interface AccountTx {
  hash: string;
  height: number;
}

export type TxApiOptions = Omit<RequesterOptions, "name"> & { baseUrl: string };

/** Block times are nanosecond integers, past what a JSON number keeps exactly: read them as strings. */
export function parseApiJson<T>(text: string): T {
  return JSON.parse(text.replace(/"block_timestamp":\s*(\d+)/g, '"block_timestamp":"$1"')) as T;
}

/** A nanosecond timestamp as a Date (milliseconds, rounded down like block times elsewhere). */
export const nsToDate = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n));

export class TxApi {
  private readonly http: Requester;

  constructor(private readonly o: TxApiOptions) {
    this.http = new Requester({ ...o, name: "tx api" });
  }

  get requests(): number {
    return this.http.requests;
  }

  /** API keys dropped after FastNEAR refused them. */
  get refusedKeys(): number {
    return this.http.refusedKeys;
  }

  private post<T>(what: string, path: string, body: unknown): Promise<T> {
    return this.http.retrying(what, async () => {
      const res = await this.http.send(new URL(path, this.o.baseUrl), { method: "POST", body: JSON.stringify(body) });
      await this.http.check(res);
      return parseApiJson<T>(await res.text());
    });
  }

  /** The newest `limit` committed blocks, newest first; with `to`, the newest at or below it. */
  async blocks(limit: number, to?: number): Promise<ApiBlock[]> {
    const r = await this.post<{ blocks: Array<{ block_height: number; block_timestamp: string }> }>("blocks", "/v0/blocks", {
      limit,
      desc: true,
      ...(to === undefined ? {} : { to_block_height: to }),
    });
    return r.blocks.map((b) => ({ height: b.block_height, time: nsToDate(b.block_timestamp) }));
  }

  /** One page of the transactions that touched `account`, included from `from` to `to`, oldest first. */
  async accountTxs(account: string, from: number, to: number, resume?: string): Promise<{ txs: AccountTx[]; resume: string | null }> {
    const r = await this.post<{ account_txs: Array<{ transaction_hash: string; tx_block_height: number }>; resume_token?: string }>(
      `account ${account}`,
      "/v0/account",
      { account_id: account, from_tx_block_height: from, to_tx_block_height: to, desc: false, limit: 200, ...(resume ? { resume_token: resume } : {}) },
    );
    return { txs: r.account_txs.map((t) => ({ hash: t.transaction_hash, height: t.tx_block_height })), resume: r.resume_token ?? null };
  }

  /** Transactions by hash (at most 20); unknown hashes are left out. */
  async transactions(hashes: string[]): Promise<TxRecord[]> {
    if (!hashes.length) return [];
    const r = await this.post<{ transactions: TxRecord[] }>(`${hashes.length} transactions`, "/v0/transactions", { tx_hashes: hashes });
    return r.transactions;
  }
}

