import { query } from "./http";
import { Polite, type PoliteOptions } from "./polite";

/**
 * Hacker News through Algolia's search API (https://hn.algolia.com/api), keyless (10,000 requests
 * an hour per IP). `search_by_date` with a `created_at_i` filter and `hitsPerPage=1` reads
 * `nbHits`: stories and comments mentioning a keyword in the window. Algolia has no OR across
 * phrases, so each keyword is one call (at most three) and the counts are summed. Typo tolerance
 * is off: with it, "Starlink" also matches "Starling" and inflates counts tenfold.
 */

export const HN_API = "https://hn.algolia.com/api/v1";
export const HN_MAX_KEYWORDS = 3;

export class HackerNews {
  readonly http: Polite;

  constructor(
    private readonly baseUrl = HN_API,
    opts: Partial<PoliteOptions> = {},
  ) {
    this.http = new Polite("hn", { spacingMs: 500, ...opts });
  }

  get available(): boolean {
    return this.http.available;
  }

  /** Stories and comments mentioning any keyword since `fromSec`, summed over the keywords. */
  async mentions(keywords: readonly string[], fromSec: number): Promise<number> {
    const terms = hnTerms(keywords);
    if (terms.length === 0) throw new Error("hn: no keyword to search");
    let total = 0;
    for (const term of terms) {
      const json = await this.http.json<{ nbHits?: unknown }>(
        `${this.baseUrl}/search_by_date?${query({ query: term, numericFilters: `created_at_i>${Math.floor(fromSec)}`, hitsPerPage: 1, typoTolerance: "false" })}`,
      );
      if (typeof json.nbHits !== "number" || !Number.isFinite(json.nbHits) || json.nbHits < 0) throw new Error("hn: malformed search response");
      total += json.nbHits;
    }
    return total;
  }
}

/**
 * Distinct search terms, at most three. Cashtags are dropped: Algolia finds nothing for `$PLTR`,
 * and the bare ticker (`NEAR`, `DOT`) is often an everyday word.
 */
export function hnTerms(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keywords) {
    if (k.trim().startsWith("$")) continue;
    const t = k.trim().replace(/"/g, "").trim();
    if (t.length < 2 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, HN_MAX_KEYWORDS);
}
