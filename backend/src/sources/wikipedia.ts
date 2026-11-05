import { type Fetch, fetchJson, HttpError } from "./http";

/**
 * Wikimedia pageviews (https://doc.wikimedia.org/generated-docs/analytics-api/), keyless. Human
 * views of an article over the last complete UTC day, and the day's most-viewed articles, which
 * the radar reads for non-crypto topics.
 *
 * Wikimedia rate-limits per minute by client identity: 10 requests for clients without contact
 * details in their User-Agent, 200 for a compliant User-Agent (name, version, and a URL or email).
 * Every Wikimedia call in the process goes through one paced queue, and a 429 rests the queue for
 * its Retry-After.
 */

export interface TopArticle {
  article: string;
  views: number;
  rank: number;
}

/** Namespaces and pages that are never topics. */
const NOT_A_TOPIC = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Template:|Category:|User:|Deaths_in_|List_of_|\d{4}_in_)/;

const pad = (n: number) => String(n).padStart(2, "0");

/** The UTC day before `atMs`, the latest day with complete data. */
export function lastCompleteDay(atMs: number): Date {
  return new Date(atMs - 86_400_000);
}

/** True when a User-Agent carries contact details (a URL or an email), as Wikimedia's policy asks. */
export function hasContact(userAgent: string): boolean {
  return /https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+/.test(userAgent);
}

export class Wikipedia {
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private readonly spacingMs: number;
  readonly fetchPaced: Fetch;

  constructor(
    readonly userAgent: string,
    private readonly project = "en.wikipedia",
    private readonly fetchImpl: Fetch = fetch,
    opts: { requestsPerMinute?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
  ) {
    const rpm = opts.requestsPerMinute ?? (hasContact(userAgent) ? 100 : 8);
    this.spacingMs = Math.ceil(60_000 / rpm);
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.now ?? Date.now;
    this.fetchPaced = (input, init) => {
      const run = this.queue.then(async () => {
        const wait = this.nextAt - now();
        if (wait > 0) await sleep(wait);
        this.nextAt = now() + this.spacingMs;
        const res = await this.fetchImpl(input, init);
        if (res.status === 429) {
          const retry = Number(res.headers.get("retry-after"));
          this.nextAt = now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000);
        }
        return res;
      });
      this.queue = run.catch(() => undefined);
      return run;
    };
  }

  /** Views of `article` on `day`, or 0 when the article had none or does not exist. */
  async pageviews(article: string, day: Date): Promise<number> {
    const d = `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}00`;
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${this.project}/all-access/user/${encodeURIComponent(article)}/daily/${d}/${d}`;
    try {
      const json = await fetchJson<{ items?: Array<{ views?: unknown }> }>(this.fetchPaced, "wikipedia", url, { headers: this.headers() });
      return (json.items ?? []).reduce((a, i) => a + (typeof i.views === "number" ? i.views : 0), 0);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return 0;
      throw e;
    }
  }

  /** The day's most-viewed articles, without the main page, special pages and lists. */
  async topArticles(day: Date, limit = 50): Promise<TopArticle[]> {
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${this.project}/all-access/${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}`;
    const json = await fetchJson<{ items?: Array<{ articles?: Array<{ article?: unknown; views?: unknown; rank?: unknown }> }> }>(
      this.fetchPaced,
      "wikipedia",
      url,
      { headers: this.headers() },
    );
    const out: TopArticle[] = [];
    for (const a of json.items?.[0]?.articles ?? []) {
      if (typeof a.article !== "string" || typeof a.views !== "number" || NOT_A_TOPIC.test(a.article)) continue;
      out.push({ article: a.article, views: a.views, rank: typeof a.rank === "number" ? a.rank : out.length + 1 });
      if (out.length >= limit) break;
    }
    return out;
  }

  private headers() {
    return { "user-agent": this.userAgent, accept: "application/json" };
  }

  /** The canonical title of an article after redirects, or null when there is none or it is a disambiguation page. */
  async canonicalTitle(title: string): Promise<string | null> {
    const host = `${this.project.replace(/\.wikipedia$/, "")}.wikipedia.org`;
    try {
      const json = await fetchJson<{ type?: string; titles?: { canonical?: string } }>(
        this.fetchPaced,
        "wikipedia",
        `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`,
        { headers: this.headers() },
      );
      if (json.type === "disambiguation") return null;
      return json.titles?.canonical ?? null;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }
}
