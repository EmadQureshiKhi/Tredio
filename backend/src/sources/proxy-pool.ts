import type { Fetch, FetchInit } from "./http";
import { proxyHost } from "./elfa-proxies";

/**
 * A single retry for the small keyless sources after a 403 or 429, never the first attempt and
 * never any other host (KEYLESS_FALLBACK_HOSTS is the whole list). Its traffic has a monthly budget
 * (default 300 MB) counted in memory per UTC month, so a restart starts the count again.
 */

/** The only hosts a fallback may reach. */
export const KEYLESS_FALLBACK_HOSTS: ReadonlySet<string> = new Set([
  "api.bsky.app",
  "api.coingecko.com",
  "api.geckoterminal.com",
  "hn.algolia.com",
  "wikimedia.org",
  "en.wikipedia.org",
  "api.gdeltproject.org",
]);

/** Statuses that say "not from this IP right now", the only ones a fallback answers. */
const FALLBACK_STATUSES: ReadonlySet<number> = new Set([403, 429]);
export const DEFAULT_FALLBACK_BYTES_PER_MONTH = 300 * 1024 * 1024;
/** Headers both ways and the CONNECT tunnel's TLS handshake, counted generously. */
export const OVERHEAD_BYTES_PER_REQUEST = 8 * 1024;

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export interface FallbackStats {
  month: string;
  bytes: number;
  capBytes: number;
  requests: number;
}

export class ProxyFallback {
  private used = { month: "", bytes: 0, requests: 0 };
  private next = 0;

  constructor(
    private readonly proxies: readonly string[],
    private readonly opts: {
      capBytes?: number;
      /** Routes whose Elfa key has a request in flight. */
      busy?: () => ReadonlySet<string>;
      now?: () => number;
    } = {},
  ) {}

  get stats(): FallbackStats {
    this.roll();
    return { ...this.used, capBytes: this.cap };
  }

  /** A Fetch that calls directly and, only on a 403 or 429 from a listed keyless host, once more through a route. */
  wrap(fetchImpl: Fetch): Fetch {
    return async (url, init) => {
      const { proxy: _never, ...direct } = (init ?? {}) as FetchInit;
      const res = await fetchImpl(url, direct);
      if (!FALLBACK_STATUSES.has(res.status) || !KEYLESS_FALLBACK_HOSTS.has(new URL(url).hostname)) return res;
      const proxy = this.pick();
      if (!proxy) return res;
      await res.body?.cancel().catch(() => {});
      return this.through(fetchImpl, url, direct, proxy);
    };
  }

  private get cap(): number {
    return this.opts.capBytes ?? DEFAULT_FALLBACK_BYTES_PER_MONTH;
  }

  private roll(): void {
    const m = month((this.opts.now ?? Date.now)());
    if (this.used.month !== m) this.used = { month: m, bytes: 0, requests: 0 };
  }

  /**
   * Lanes for a client that paces itself (GDELT): one per entry, ready while that entry's Elfa key
   * is idle and the month's traffic, with the next request, stays within `share` of the cap.
   */
  lanes(fetchImpl: Fetch, opts: { share?: number } = {}): Array<{ id: string; fetch: Fetch; ready: () => boolean }> {
    return this.proxies.map((proxy, i) => ({
      id: `fallback-${i + 1}`,
      fetch: (url: string, init?: FetchInit) => {
        const { proxy: _never, ...plain } = (init ?? {}) as FetchInit;
        return this.through(fetchImpl, url, plain, proxy);
      },
      ready: () => this.fits(opts.share ?? 1) && !(this.opts.busy?.().has(proxy) ?? false),
    }));
  }

  /** Whether the next request fits within `share` of the month's cap. */
  private fits(share = 1): boolean {
    this.roll();
    // The next request is assumed as large as the average so far, so the cap holds with room to spare.
    const next = Math.max(OVERHEAD_BYTES_PER_REQUEST, this.used.requests > 0 ? this.used.bytes / this.used.requests : 0);
    return this.proxies.length > 0 && this.used.bytes + next <= this.cap * share;
  }

  /** The next route, idle ones first, or null when there is none or the month's budget is spent. */
  private pick(): string | null {
    if (!this.fits()) return null;
    const busy = this.opts.busy?.() ?? new Set<string>();
    const order = this.proxies.map((_, i) => this.proxies[(this.next + i) % this.proxies.length]!);
    const pick = order.find((p) => !busy.has(p)) ?? order[0]!;
    this.next = (this.proxies.indexOf(pick) + 1) % this.proxies.length;
    return pick;
  }

  private async through(fetchImpl: Fetch, url: string, init: RequestInit, proxy: string): Promise<Response> {
    if (!KEYLESS_FALLBACK_HOSTS.has(new URL(url).hostname)) throw new Error(`proxy fallback: ${new URL(url).hostname} is not a keyless source`);
    const sent = url.length + (typeof init.body === "string" ? init.body.length : 0);
    this.used.requests++;
    this.used.bytes += OVERHEAD_BYTES_PER_REQUEST + sent;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, proxy });
    } catch (e) {
      // The route's own failure must not quote its credentials.
      throw new Error(`proxy fallback via ${proxyHost(proxy)} failed: ${(e instanceof Error ? e.message : String(e)).replace(/\/\/[^\s/@]+@/g, "//***@").slice(0, 120)}`);
    }
    const body = await res.arrayBuffer();
    this.used.bytes += body.byteLength;
    // The body is already decoded: drop the headers that described the encoded one.
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  }
}
