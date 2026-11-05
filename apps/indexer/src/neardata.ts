/**
 * FastNEAR's neardata block API (`/v0/block/{height}`, `/v0/last_block/final`).
 *
 * - Free use is rate limited per IP (about 30 requests a minute, measured 2026-11-05; the docs
 *   say 180), so every request (retries and head lookups included) takes a token from one bucket
 *   refilled at `rpm`.
 * - A skipped height answers `null`; a height a little past the final head is held open until it
 *   exists; one far past it answers 404 `BLOCK_DOES_NOT_EXIST`.
 * - An API key goes in `Authorization: Bearer`. Redirects (archive hosts, `last_block`) drop that
 *   header, so they are followed by hand and the header is sent again.
 * - A 429 pauses every request (Retry-After when above 0, otherwise 10 s doubling to 2 minutes
 *   while the limit lasts); 5xx answers and network errors back off per request (1 s doubling to
 *   30 s, with jitter). Both retry until the stop signal fires.
 */
import type { Log } from "./log";

export interface ReceiptOutcome {
  execution_outcome: {
    id: string;
    outcome: { executor_id: string; logs: string[]; status: unknown };
  };
  receipt?: { receipt_id?: string; receiver_id?: string; predecessor_id?: string } | null;
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

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

export class StoppedError extends Error {
  constructor() {
    super("stopped");
    this.name = "StoppedError";
  }
}

/** A token bucket shared by every request. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  /** Requests wait until this time (ms) after a rate limit. */
  pausedUntil = 0;

  constructor(
    private readonly perMinute: number,
    private readonly burst = Math.max(1, Math.min(5, Math.floor(perMinute / 60))),
  ) {
    this.tokens = this.burst;
  }

  /** Holds every request until `until`. */
  pause(until: number) {
    this.pausedUntil = Math.max(this.pausedUntil, until);
  }

  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
      this.last = now;
      const wait = Math.max(this.pausedUntil - now, this.tokens >= 1 ? 0 : ((1 - this.tokens) * 60_000) / this.perMinute);
      if (wait <= 0) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(wait), signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new StoppedError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new StoppedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface NeardataOptions {
  baseUrl: string;
  apiKey?: string;
  rpm: number;
  log: Log;
  signal?: AbortSignal;
  /** Per-request timeout; near-future heights are held open by the server for a few seconds. */
  timeoutMs?: number;
  /** Called on every retry, so a liveness check sees the loop is still working. */
  onAttempt?: () => void;
  /** First pause after a 429 without a usable Retry-After (default 10 s). */
  throttleMs?: number;
  fetch?: typeof fetch;
}

const MAX_REDIRECTS = 4;

export class Neardata {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly minThrottle: number;
  private throttle: number;
  requests = 0;

  constructor(private readonly o: NeardataOptions) {
    this.limiter = new RateLimiter(o.rpm);
    this.minThrottle = this.throttle = o.throttleMs ?? THROTTLE_MIN_MS;
    this.fetchImpl = o.fetch ?? fetch;
  }

  /** The block at `height`, a skipped height, or a height not produced yet. */
  async block(height: number): Promise<BlockResult> {
    return this.retrying(`block ${height}`, async () => {
      const res = await this.get(`/v0/block/${height}`);
      if (res.status === 404) {
        const body = (await res.json().catch(() => ({}))) as { type?: string; error?: string };
        if (body.type === "BLOCK_HEIGHT_TOO_LOW") throw new FatalError(`block ${height} is below the neardata archive (${body.error ?? body.type})`);
        return { kind: "future", height } as const;
      }
      await this.check(res);
      const text = await res.text();
      const block = JSON.parse(text) as Block | null;
      if (block === null) return { kind: "skipped", height } as const;
      if (block?.block?.header?.height !== height) throw new Error(`block ${height}: unexpected body`);
      return { kind: "block", height, block } as const;
    });
  }

  /** The final head's height, read from the `last_block/final` redirect without fetching the block. */
  async finalHeight(): Promise<number> {
    return this.retrying("final head", async () => {
      const res = await this.get("/v0/last_block/final", false);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const m = /\/v0\/block\/(\d+)/.exec(location);
        if (m) return Number(m[1]);
      }
      await this.check(res);
      const block = (await res.json()) as Block;
      return block.block.header.height;
    });
  }

  private async check(res: Response): Promise<void> {
    if (res.ok) return;
    const text = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new FatalError(`neardata refused the request (${res.status}): check NEARDATA_API_KEY`);
    throw new HttpError(res.status, text, res.headers.get("retry-after"));
  }

  /** GET with manual redirects, so the API key header survives them. */
  private async get(path: string, follow = true): Promise<Response> {
    let url = new URL(path, this.o.baseUrl);
    for (let hop = 0; ; hop++) {
      await this.limiter.take(this.o.signal);
      this.requests++;
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.o.apiKey) headers.authorization = `Bearer ${this.o.apiKey}`;
      const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 30_000);
      const signal = this.o.signal ? AbortSignal.any([this.o.signal, timeout]) : timeout;
      const res = await this.fetchImpl(url, { headers, redirect: "manual", signal });
      const location = res.headers.get("location");
      if (!follow || res.status < 300 || res.status >= 400 || !location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects for ${path}`);
      await res.body?.cancel();
      url = new URL(location, url);
    }
  }

  private async retrying<T>(what: string, run: () => Promise<T>): Promise<T> {
    let delay = 1_000;
    for (let attempt = 1; ; attempt++) {
      this.o.onAttempt?.();
      try {
        const r = await run();
        this.throttle = this.minThrottle;
        return r;
      } catch (e) {
        if (e instanceof FatalError || this.o.signal?.aborted) throw this.o.signal?.aborted ? new StoppedError() : e;
        if (e instanceof HttpError && e.status === 429) {
          // Every request waits out a rate limit (the next attempt waits in the limiter). Only a
          // limit hit after the last pause ended extends it, doubling the pause each time.
          const now = Date.now();
          if (now >= this.limiter.pausedUntil) {
            const wait = Math.max(retryAfterMs(e.retryAfter), this.throttle);
            this.limiter.pause(now + wait);
            this.throttle = Math.min(this.throttle * 2, THROTTLE_MAX_MS);
            this.o.log.warn("neardata rate limit, pausing", { what, waitMs: wait, rpm: this.o.rpm, error: describe(e) });
          }
          continue;
        }
        const wait = delay * (0.75 + Math.random() * 0.5);
        this.o.log.warn("neardata retry", { what, attempt, waitMs: Math.round(wait), error: describe(e) });
        await sleep(wait, this.o.signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }
}

const THROTTLE_MIN_MS = 10_000;
const THROTTLE_MAX_MS = 120_000;

/** Retry-After in ms (seconds or an HTTP date); 0 when absent or not positive. */
function retryAfterMs(v: string | null): number {
  if (!v) return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  return Math.max(0, Date.parse(v) - Date.now() || 0);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "HttpError";
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === "TimeoutError" ? "timeout" : e.message;
  return String(e);
}
