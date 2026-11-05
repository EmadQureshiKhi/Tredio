import { type Fetch, HttpError } from "./http";

/**
 * A polite client for keyless public APIs (Bluesky, CoinGecko, GeckoTerminal, Hacker News). Every
 * request of a source goes through one queue spaced at least `spacingMs` apart, times out, and is
 * retried with exponential backoff after a network error, a 429 or a 5xx. A 429's Retry-After
 * spaces the queue, and a source that keeps refusing is benched with a growing backoff, so a rate
 * limit is never answered with more requests.
 */

export interface PoliteOptions {
  /** Shortest gap between two requests' starts. */
  spacingMs: number;
  /** Retries after the first attempt. */
  retries?: number;
  /** First retry delay; each retry doubles it. */
  backoffMs?: number;
  timeoutMs?: number;
  /** Sent on every request; public APIs ask clients to identify themselves. */
  userAgent?: string;
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The longest Retry-After waited out inline; a longer one benches the source instead. */
export const MAX_INLINE_WAIT_MS = 30_000;
const FIRST_BENCH_MS = 60_000;
const MAX_BENCH_MS = 3_600_000;

const retryable = (e: unknown) => !(e instanceof HttpError) || e.status === 429 || e.status >= 500;

export class Polite {
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private benchedUntil = 0;
  private benchMs = FIRST_BENCH_MS;
  private readonly fetchImpl: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    readonly source: string,
    private readonly opts: PoliteOptions,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** False while the source is benched after refusing requests. */
  get available(): boolean {
    return this.now() >= this.benchedUntil;
  }

  /** GETs `url` and parses JSON, with spacing, timeout and retries. */
  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const body = await this.text(url, init);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`${this.source}: response is not JSON: ${body.slice(0, 160)}`);
    }
  }

  async text(url: string, init: RequestInit = {}): Promise<string> {
    const retries = this.opts.retries ?? 2;
    const backoff = this.opts.backoffMs ?? 2_000;
    for (let attempt = 0; ; attempt++) {
      if (!this.available) throw new Error(`${this.source}: resting after rate limiting`);
      try {
        const body = await this.once(url, init);
        this.benchMs = FIRST_BENCH_MS;
        return body;
      } catch (e) {
        if (!retryable(e) || attempt >= retries || !this.available) {
          if (e instanceof HttpError && e.status === 429) this.bench();
          throw e;
        }
        await this.sleep(backoff * 2 ** attempt);
      }
    }
  }

  private once(url: string, init: RequestInit): Promise<string> {
    const run = this.queue.then(async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = this.now() + this.opts.spacingMs;
      const { proxy: _never, ...plain } = init as RequestInit & { proxy?: string };
      const headers = { accept: "application/json", ...(this.opts.userAgent ? { "user-agent": this.opts.userAgent } : {}), ...(init.headers as Record<string, string> | undefined) };
      const res = await this.fetchImpl(url, { ...plain, headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
      const body = await res.text();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.opts.spacingMs * 4;
        if (ms > MAX_INLINE_WAIT_MS) this.bench(ms);
        else this.nextAt = Math.max(this.nextAt, this.now() + ms);
      }
      if (!res.ok) throw new HttpError(this.source, res.status, body);
      return body;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private bench(ms = this.benchMs): void {
    this.benchedUntil = Math.max(this.benchedUntil, this.now() + ms);
    this.benchMs = Math.min(this.benchMs * 2, MAX_BENCH_MS);
  }
}

/** Remembers one value for `ttlMs`, so a list several callers read is fetched once per period. */
export class TtlCache<T> {
  private value: { at: number; v: T } | null = null;
  private pending: Promise<T> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(load: () => Promise<T>): Promise<T> {
    if (this.value && this.now() - this.value.at < this.ttlMs) return Promise.resolve(this.value.v);
    if (this.pending) return this.pending;
    this.pending = load()
      .then((v) => {
        this.value = { at: this.now(), v };
        return v;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
