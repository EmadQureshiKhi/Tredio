import { query } from "./http";
import { Polite, type PoliteOptions, TtlCache } from "./polite";

/**
 * Bluesky's public AppView (https://docs.bsky.app), keyless. Two reads:
 * - `app.bsky.feed.searchPosts`: posts matching a query in a window. `hitsTotal` counts every
 *   match (Bluesky caps it at 10,000), so one call with `limit=1` measures a trend's mentions.
 *   Keywords are ORed with `|` in one query (the search ignores a literal "OR").
 * - `app.bsky.unspecced.getTrends`: the topics trending on Bluesky now, which the radar reads.
 * `public.api.bsky.app` refuses search (403), so both go to `api.bsky.app`. The AppView rate
 * limits per IP (3,000 requests per 5 minutes); requests here are spaced a second apart.
 */

export const BLUESKY_API = "https://api.bsky.app";
/** Bluesky reports at most this many hits for a search. */
export const BLUESKY_HITS_CAP = 10_000;
export const BLUESKY_SPACING_MS = 1_000;
const TRENDS_TTL_MS = 10 * 60_000;

export interface BlueskyTrend {
  topic: string;
  displayName: string;
  description: string | null;
  postCount: number;
  category: string | null;
  /** `hot`, `trending` or `cooling`. */
  status: string | null;
  startedAt: string | null;
  /** The trend's feed on bsky.app. */
  link: string | null;
}

export class Bluesky {
  readonly http: Polite;
  private readonly trendsCache: TtlCache<BlueskyTrend[]>;

  constructor(
    private readonly baseUrl = BLUESKY_API,
    opts: Partial<PoliteOptions> = {},
  ) {
    this.http = new Polite("bluesky", { spacingMs: BLUESKY_SPACING_MS, ...opts });
    this.trendsCache = new TtlCache(TRENDS_TTL_MS, opts.now);
  }

  get available(): boolean {
    return this.http.available;
  }

  /** Posts matching any keyword in [fromSec, toSec], capped at 10,000 by Bluesky. */
  async mentions(keywords: readonly string[], fromSec: number, toSec: number): Promise<number> {
    const q = blueskyQuery(keywords);
    if (q === null) throw new Error("bluesky: no keyword to search");
    const json = await this.http.json<{ hitsTotal?: unknown }>(
      `${this.baseUrl}/xrpc/app.bsky.feed.searchPosts?${query({ q, since: iso(fromSec), until: iso(toSec), limit: 1 })}`,
    );
    const total = json.hitsTotal;
    // Bluesky leaves hitsTotal out when nothing matched.
    if (total === undefined) return 0;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) throw new Error("bluesky: malformed searchPosts response");
    return Math.min(total, BLUESKY_HITS_CAP);
  }

  /** Topics trending on Bluesky now, fetched at most once every ten minutes. */
  trends(limit = 25): Promise<BlueskyTrend[]> {
    return this.trendsCache.get(async () => parseTrends(await this.http.json(`${this.baseUrl}/xrpc/app.bsky.unspecced.getTrends?${query({ limit })}`)));
  }
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * A search query from keywords: phrases quoted, terms joined by `|` (OR). Cashtags are dropped:
 * the search tokenizes `$` away, so `$NEAR` would count every post saying "near". Crypto trends
 * carry the token's name as a keyword too.
 */
export function blueskyQuery(keywords: readonly string[]): string | null {
  const terms = [...new Set(keywords.map((k) => k.trim()).filter((k) => !k.startsWith("$")).map((k) => k.replace(/["|()]/g, "").trim()).filter((k) => k.length >= 2))].slice(0, 5);
  if (terms.length === 0) return null;
  return terms.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" | ");
}

export function parseTrends(json: unknown): BlueskyTrend[] {
  const rows = (json as { trends?: unknown })?.trends;
  if (!Array.isArray(rows)) throw new Error("bluesky: malformed getTrends response");
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const out: BlueskyTrend[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const displayName = str(r.displayName);
    const topic = str(r.topic);
    if (!displayName || !topic) continue;
    const link = str(r.link);
    out.push({
      topic,
      displayName,
      description: str(r.description),
      postCount: typeof r.postCount === "number" && Number.isFinite(r.postCount) ? r.postCount : 0,
      category: str(r.category),
      status: str(r.status),
      startedAt: str(r.startedAt),
      link: link ? (link.startsWith("/") ? `https://bsky.app${link}` : link) : null,
    });
  }
  return out;
}
