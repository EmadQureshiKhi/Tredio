import { type ErrorLog, scrub } from "../errors";
import type { Fetch } from "./http";

/**
 * Per-source request counters for the admin system view: every request a source client makes,
 * its outcome, the last success and the last error. Kept in memory from the process start. The
 * last error is scrubbed (URLs cut to their host, credentials and keys masked) before it is kept.
 */

export interface SourceStat {
  name: string;
  requests: number;
  ok: number;
  /** Network failures and refusals other than 429 (a 404 is an answer, counted as ok). */
  errors: number;
  /** 429 answers. */
  rateLimited: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** The last answer's HTTP status; null after a network failure or before any request. */
  lastStatus: number | null;
}

export class SourceStats {
  private readonly stats = new Map<string, SourceStat>();

  constructor(
    private readonly errors: ErrorLog | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  private of(name: string): SourceStat {
    let s = this.stats.get(name);
    if (!s) {
      s = { name, requests: 0, ok: 0, errors: 0, rateLimited: 0, lastOkAt: null, lastErrorAt: null, lastError: null, lastStatus: null };
      this.stats.set(name, s);
    }
    return s;
  }

  /** Registers a source before its first request, so it shows as idle rather than missing. */
  register(name: string): void {
    this.of(name);
  }

  /** A Fetch that counts every request `name` makes and how it ended. */
  track(name: string, fetchImpl: Fetch): Fetch {
    this.of(name);
    return async (url, init) => {
      const s = this.of(name);
      s.requests++;
      let res: Response;
      try {
        res = await fetchImpl(url, init);
      } catch (e) {
        this.failed(name, e instanceof Error ? e.message : String(e), null);
        throw e;
      }
      s.lastStatus = res.status;
      // A 404 answers the question (no such article, no such token): the source works.
      if (res.ok || res.status === 404) {
        s.ok++;
        s.lastOkAt = this.now();
      } else this.failed(name, `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`, res.status);
      return res;
    };
  }

  private failed(name: string, message: string, status: number | null): void {
    const s = this.of(name);
    if (status === 429) s.rateLimited++;
    else s.errors++;
    s.lastStatus = status;
    s.lastErrorAt = this.now();
    s.lastError = scrub(`${name}: ${message}`, 200);
    this.errors?.note(name, s.lastError, s.lastErrorAt);
  }

  report(): SourceStat[] {
    return [...this.stats.values()].map((s) => ({ ...s }));
  }
}
