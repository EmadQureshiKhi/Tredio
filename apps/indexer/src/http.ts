/**
 * HTTP for FastNEAR's APIs (neardata and the transactions API), both rate limited per IP.
 *
 * - Every request (retries and redirects included) takes a token from one bucket refilled at
 *   `rpm` a minute.
 * - A 429 pauses every request: Retry-After when above 0 (FastNEAR sends 0), otherwise 10 s
 *   doubling to 2 minutes while the limit lasts. 5xx answers and network errors back off per
 *   request (1 s doubling to 30 s, with jitter). Both retry until the stop signal fires.
 * - An API key goes in `Authorization: Bearer`, several keys in turn. Redirects drop that header,
 *   so they are followed by hand and the header is sent again.
 * - A 401 or 403 drops the key that drew it and the request goes again with the next; it is fatal
 *   only for the last key (or without one).
 */
import type { Log } from "./log";

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}

/** A key was refused and dropped; the request goes again at once with the next key. */
class KeyRefusedError extends Error {
  constructor() {
    super("key refused");
    this.name = "KeyRefusedError";
  }
}

export class StoppedError extends Error {
  constructor() {
    super("stopped");
    this.name = "StoppedError";
  }
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

/** A token bucket shared by every request of one client. */
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

export interface RequesterOptions {
  /** For logs: "neardata" or "tx api". */
  name: string;
  /** FastNEAR API keys, taken in turn. */
  apiKeys?: readonly string[];
  rpm: number;
  log: Log;
  signal?: AbortSignal;
  /** Per-request timeout (default 30 s). */
  timeoutMs?: number;
  /** Called on every attempt, so a liveness check sees the loop is still working. */
  onAttempt?: () => void;
  /** First pause after a 429 without a usable Retry-After (default 10 s). */
  throttleMs?: number;
  fetch?: typeof fetch;
}

const MAX_REDIRECTS = 4;
const THROTTLE_MIN_MS = 10_000;
const THROTTLE_MAX_MS = 120_000;

export class Requester {
  readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly minThrottle: number;
  private throttle: number;
  private keys: string[];
  private turn = 0;
  private readonly keyOf = new WeakMap<Response, string>();
  requests = 0;

  constructor(private readonly o: RequesterOptions) {
    this.keys = [...new Set(o.apiKeys ?? [])];
    this.limiter = new RateLimiter(o.rpm);
    this.minThrottle = this.throttle = o.throttleMs ?? THROTTLE_MIN_MS;
    this.fetchImpl = o.fetch ?? fetch;
  }

  /** One request, redirects followed by hand (unless `follow` is false) so the key header survives. */
  async send(url: URL, init: { method?: string; body?: string } = {}, follow = true): Promise<Response> {
    const key = this.keys.length > 0 ? this.keys[this.turn++ % this.keys.length] : undefined;
    for (let hop = 0; ; hop++) {
      await this.limiter.take(this.o.signal);
      this.requests++;
      const headers: Record<string, string> = { accept: "application/json" };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      if (key) headers.authorization = `Bearer ${key}`;
      const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 30_000);
      const signal = this.o.signal ? AbortSignal.any([this.o.signal, timeout]) : timeout;
      const res = await this.fetchImpl(url, { method: init.method ?? "GET", body: init.body, headers, redirect: "manual", signal });
      const location = res.headers.get("location");
      if (key) this.keyOf.set(res, key);
      if (!follow || res.status < 300 || res.status >= 400 || !location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects for ${url.pathname}`);
      await res.body?.cancel();
      url = new URL(location, url);
    }
  }

  /** Throws for anything but a 2xx answer: on 401/403 the key is dropped (FatalError for the last one), HttpError otherwise. */
  async check(res: Response): Promise<void> {
    if (res.ok) return;
    const text = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      const key = this.keyOf.get(res);
      if (key && this.keys.length > 1) {
        this.keys = this.keys.filter((k) => k !== key);
        this.o.log.warn(`${this.o.name} refused an API key; going on with the others`, { status: res.status, keysLeft: this.keys.length });
        throw new KeyRefusedError();
      }
      throw new FatalError(`${this.o.name} refused the request (${res.status}): check the API key`);
    }
    throw new HttpError(res.status, text, res.headers.get("retry-after"));
  }

  async retrying<T>(what: string, run: () => Promise<T>): Promise<T> {
    let delay = 1_000;
    for (let attempt = 1; ; attempt++) {
      this.o.onAttempt?.();
      try {
        const r = await run();
        this.throttle = this.minThrottle;
        return r;
      } catch (e) {
        if (e instanceof FatalError || this.o.signal?.aborted) throw this.o.signal?.aborted ? new StoppedError() : e;
        if (e instanceof KeyRefusedError) continue;
        if (e instanceof HttpError && e.status === 429) {
          // Every request waits out a rate limit (the next attempt waits in the limiter). Only a
          // limit hit after the last pause ended extends it, doubling the pause each time.
          const now = Date.now();
          if (now >= this.limiter.pausedUntil) {
            const wait = Math.max(retryAfterMs(e.retryAfter), this.throttle);
            this.limiter.pause(now + wait);
            this.throttle = Math.min(this.throttle * 2, THROTTLE_MAX_MS);
            this.o.log.warn(`${this.o.name} rate limit, pausing`, { what, waitMs: wait, rpm: this.o.rpm, error: describe(e) });
          }
          continue;
        }
        const wait = delay * (0.75 + Math.random() * 0.5);
        this.o.log.warn(`${this.o.name} retry`, { what, attempt, waitMs: Math.round(wait), error: describe(e) });
        await sleep(wait, this.o.signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }
}

/** Retry-After in ms (seconds or an HTTP date); 0 when absent or not positive. */
function retryAfterMs(v: string | null): number {
  if (!v) return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  return Math.max(0, Date.parse(v) - Date.now() || 0);
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === "TimeoutError" ? "timeout" : e.message;
  return String(e);
}
