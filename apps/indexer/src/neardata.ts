/**
 * FastNEAR's neardata block API (`/v0/block/{height}`, `/v0/last_block/final`), the
 * `INDEXER_SOURCE=blocks` feed.
 *
 * - Without a key neardata answers 429 past about 30 requests a minute per IP (measured
 *   2026-11-05; its docs say 180), slower than testnet makes blocks; rate limits, retries and the
 *   key header are handled by `Requester`.
 * - A skipped height answers `null`; a height a little past the final head is held open until it
 *   exists; one far past it answers 404 `BLOCK_DOES_NOT_EXIST`.
 */
import { FatalError, Requester, type RequesterOptions } from "./http";

export { FatalError, HttpError, RateLimiter, sleep, StoppedError } from "./http";

export interface ReceiptOutcome {
  execution_outcome: {
    id: string;
    outcome: { executor_id: string; logs: string[]; status: unknown };
  };
  receipt?: {
    receipt_id?: string;
    receiver_id?: string;
    predecessor_id?: string;
    receipt?: { Action?: { input_data_ids?: string[] } } & Record<string, unknown>;
  } | null;
  tx_hash?: string | null;
}

export interface Shard {
  shard_id: number;
  receipt_execution_outcomes: ReceiptOutcome[];
}

export interface Block {
  block: { header: { height: number; timestamp: number; timestamp_nanosec?: string; hash: string; prev_height?: number | null } };
  shards: Shard[];
}

export type BlockResult = { kind: "block"; height: number; block: Block } | { kind: "skipped"; height: number } | { kind: "future"; height: number };

export type NeardataOptions = Omit<RequesterOptions, "name"> & { baseUrl: string };

export class Neardata {
  private readonly http: Requester;

  constructor(private readonly o: NeardataOptions) {
    this.http = new Requester({ ...o, name: "neardata" });
  }

  get requests(): number {
    return this.http.requests;
  }

  /** The block at `height`, a skipped height, or a height not produced yet. */
  async block(height: number): Promise<BlockResult> {
    return this.http.retrying(`block ${height}`, async () => {
      const res = await this.http.send(new URL(`/v0/block/${height}`, this.o.baseUrl));
      if (res.status === 404) {
        const body = (await res.json().catch(() => ({}))) as { type?: string; error?: string };
        if (body.type === "BLOCK_HEIGHT_TOO_LOW") throw new FatalError(`block ${height} is below the neardata archive (${body.error ?? body.type})`);
        return { kind: "future", height } as const;
      }
      await this.http.check(res);
      const block = JSON.parse(await res.text()) as Block | null;
      if (block === null) return { kind: "skipped", height } as const;
      if (block?.block?.header?.height !== height) throw new Error(`block ${height}: unexpected body`);
      return { kind: "block", height, block } as const;
    });
  }

  /** The final head's height, read from the `last_block/final` redirect without fetching the block. */
  async finalHeight(): Promise<number> {
    return this.http.retrying("final head", async () => {
      const res = await this.http.send(new URL("/v0/last_block/final", this.o.baseUrl), {}, false);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const m = /\/v0\/block\/(\d+)/.exec(location);
        if (m) return Number(m[1]);
      }
      await this.http.check(res);
      const block = (await res.json()) as Block;
      return block.block.header.height;
    });
  }
}
