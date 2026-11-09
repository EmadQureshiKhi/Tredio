import { describe, expect, test } from "bun:test";
import { BLUESKY_HITS_CAP, Bluesky, blueskyQuery, parseTrends } from "../src/sources/bluesky";
import { CoinGecko, parseTrending } from "../src/sources/coingecko";
import { GeckoTerminal, parseTrendingPools } from "../src/sources/geckoterminal";
import { HackerNews, hnTerms } from "../src/sources/hackernews";
import { HttpError } from "../src/sources/http";
import { Polite, TtlCache } from "../src/sources/polite";
import { fakeFetch, json } from "./helpers";

/** A clock the fake sleep advances, so pacing is measured without waiting. */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

// Trimmed from live answers.
const bskyTrends = {
  trends: [
    { topic: "c6946312b704", displayName: "Ken Paxton's Texas Senate campaign", description: "Paxton faces Talarico.", link: "/profile/did:plc:q/feed/c6946312b704", startedAt: "2026-10-12T20:01:00Z", postCount: 294, status: "trending", category: "politics", actors: [] },
    { topic: "19d6fa697750", displayName: "Tom Cruise's film 'Digger'", link: "/profile/did:plc:q/feed/19d6fa697750", postCount: 4108, status: "cooling", category: "entertainment" },
    { topic: "", displayName: "no topic id" },
  ],
};
const geckoTrending = {
  coins: [
    { item: { id: "near", name: "NEAR Protocol", symbol: "NEAR", market_cap_rank: 20, score: 1, data: { price_change_percentage_24h: { usd: -12.77, eur: -12.4 } } } },
    { item: { id: "bunker-mode", name: "Bunker Mode", symbol: "bunker", market_cap_rank: null, score: 0 } },
    { item: { id: "broken" } },
  ],
  nfts: [{ id: "ordinal-maxi-biz-omb", name: "Ordinal Maxi Biz (OMB)", symbol: "OMB" }],
  categories: [{ id: 346, name: "Bitcoin Sidechains", slug: "bitcoin-layer-2", data: { market_cap_change_percentage_24h: { usd: -12.24 } } }],
};
const pools = {
  data: [
    {
      id: "solana_pool1",
      type: "pool",
      attributes: { address: "pool1", name: "FIGHT / SOL", reserve_in_usd: "41852.4", volume_usd: { h24: "1536288.9" }, price_change_percentage: { h24: "381.8" } },
      relationships: { base_token: { data: { id: "solana_tok1", type: "token" } }, network: { data: { id: "solana", type: "network" } } },
    },
    { id: "eth_pool2", type: "pool", attributes: { address: "pool2", name: "X / WETH" }, relationships: { base_token: { data: { id: "eth_missing", type: "token" } } } },
  ],
  included: [{ id: "solana_tok1", type: "token", attributes: { symbol: "fight", name: "Token Battles" } }],
};

describe("Polite", () => {
  test("spaces requests, retries a 5xx with backoff, and gives up on a 4xx at once", async () => {
    const c = clock();
    let n = 0;
    const f = fakeFetch([
      [/flaky/, () => (++n < 3 ? new Response("busy", { status: 503 }) : json({ ok: true }))],
      [/missing/, () => new Response("nope", { status: 404 })],
    ]);
    const p = new Polite("t", { spacingMs: 1_000, backoffMs: 500, fetchImpl: f.impl, sleep: c.sleep, now: c.now });
    expect(await p.json<{ ok: boolean }>("https://x/flaky")).toEqual({ ok: true });
    expect(f.calls).toHaveLength(3);
    // Backoff doubles, and spacing holds between attempts.
    expect(c.sleeps.filter((ms) => ms === 500 || ms === 1_000).length).toBeGreaterThanOrEqual(2);
    await expect(p.json("https://x/missing")).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(4);
  });

  test("waits out a short Retry-After, and benches the source after a long one", async () => {
    const c = clock();
    let n = 0;
    const f = fakeFetch([
      [/short/, () => (++n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "5" } }) : json({ ok: 1 }))],
      [/long/, () => new Response("later", { status: 429, headers: { "retry-after": "600" } })],
    ]);
    const p = new Polite("t", { spacingMs: 100, backoffMs: 100, fetchImpl: f.impl, sleep: c.sleep, now: c.now });
    const start = c.now();
    expect(await p.json<{ ok: number }>("https://x/short")).toEqual({ ok: 1 });
    expect(c.now() - start).toBeGreaterThanOrEqual(5_000);
    await expect(p.json("https://x/long")).rejects.toThrow("HTTP 429");
    expect(p.available).toBe(false);
    // While benched no request goes out.
    const calls = f.calls.length;
    await expect(p.json("https://x/short")).rejects.toThrow("resting");
    expect(f.calls.length).toBe(calls);
    c.advance(601_000);
    expect(p.available).toBe(true);
  });

  test("a cache serves one load per period, and concurrent readers share it", async () => {
    const c = clock();
    const cache = new TtlCache<number>(60_000, c.now);
    let loads = 0;
    const load = async () => ++loads;
    expect(await Promise.all([cache.get(load), cache.get(load)])).toEqual([1, 1]);
    c.advance(59_000);
    expect(await cache.get(load)).toBe(1);
    c.advance(2_000);
    expect(await cache.get(load)).toBe(2);
  });
});

describe("Bluesky", () => {
  test("ORs quoted phrases with | and leaves cashtags out", () => {
    expect(blueskyQuery(["Shane Gillis", "Gillis"])).toBe('"Shane Gillis" | Gillis');
    expect(blueskyQuery(["$NEAR", "NEAR Protocol"])).toBe('"NEAR Protocol"');
    expect(blueskyQuery(["$SOL"])).toBeNull();
    expect(blueskyQuery(['a "quoted" (thing)'])).toBe('"a quoted thing"');
  });

  test("reads hitsTotal over the window with one request, capped at 10,000", async () => {
    const c = clock();
    const f = fakeFetch([[/searchPosts/, (u) => json({ posts: [], hitsTotal: u.includes("Bitcoin") ? 25_000 : 2087 })]]);
    const b = new Bluesky("https://api.bsky.app", { fetchImpl: f.impl, sleep: c.sleep, now: c.now });
    expect(await b.mentions(["Shane Gillis"], 1_791_763_200, 1_791_849_600)).toBe(2087);
    const url = new URL(f.calls[0]!.url);
    expect(url.pathname).toBe("/xrpc/app.bsky.feed.searchPosts");
    expect([url.searchParams.get("q"), url.searchParams.get("since"), url.searchParams.get("until"), url.searchParams.get("limit")]).toEqual([
      '"Shane Gillis"',
      "2026-10-12T00:00:00Z",
      "2026-10-13T00:00:00Z",
      "1",
    ]);
    expect(await b.mentions(["Bitcoin"], 0, 86_400)).toBe(BLUESKY_HITS_CAP);
  });

  test("parses trending topics with absolute links, cached for ten minutes", async () => {
    expect(parseTrends(bskyTrends)).toEqual([
      {
        topic: "c6946312b704",
        displayName: "Ken Paxton's Texas Senate campaign",
        description: "Paxton faces Talarico.",
        postCount: 294,
        category: "politics",
        status: "trending",
        startedAt: "2026-10-12T20:01:00Z",
        link: "https://bsky.app/profile/did:plc:q/feed/c6946312b704",
      },
      { topic: "19d6fa697750", displayName: "Tom Cruise's film 'Digger'", description: null, postCount: 4108, category: "entertainment", status: "cooling", startedAt: null, link: "https://bsky.app/profile/did:plc:q/feed/19d6fa697750" },
    ]);
    expect(() => parseTrends({})).toThrow("malformed");
    const c = clock();
    const f = fakeFetch([[/getTrends/, () => json(bskyTrends)]]);
    const b = new Bluesky("https://api.bsky.app", { fetchImpl: f.impl, sleep: c.sleep, now: c.now });
    await b.trends();
    await b.trends();
    expect(f.calls).toHaveLength(1);
  });
});

describe("CoinGecko and GeckoTerminal", () => {
  test("parses CoinGecko's trending coins, NFTs and categories", () => {
    const t = parseTrending(geckoTrending);
    expect(t.coins).toEqual([
      { id: "near", symbol: "NEAR", name: "NEAR Protocol", marketCapRank: 20, score: 1, priceChange24hPercent: -12.77 },
      { id: "bunker-mode", symbol: "BUNKER", name: "Bunker Mode", marketCapRank: null, score: 0, priceChange24hPercent: null },
    ]);
    expect(t.nfts).toEqual([{ id: "ordinal-maxi-biz-omb", name: "Ordinal Maxi Biz (OMB)", symbol: "OMB" }]);
    expect(t.categories).toEqual([{ name: "Bitcoin Sidechains", slug: "bitcoin-layer-2", marketCapChange24hPercent: -12.24 }]);
    expect(() => parseTrending({ error: "x" })).toThrow("malformed");
  });

  test("fetches CoinGecko at most once every ten minutes", async () => {
    const c = clock();
    const f = fakeFetch([[/search\/trending/, () => json(geckoTrending)]]);
    const g = new CoinGecko("https://api.coingecko.com/api/v3", { fetchImpl: f.impl, sleep: c.sleep, now: c.now });
    await g.trending();
    c.advance(9 * 60_000);
    await g.trending();
    expect(f.calls).toHaveLength(1);
    c.advance(2 * 60_000);
    await g.trending();
    expect(f.calls).toHaveLength(2);
  });

  test("parses GeckoTerminal pools with their base token, and skips pools without one", async () => {
    expect(parseTrendingPools(pools)).toEqual([
      { symbol: "FIGHT", tokenName: "Token Battles", network: "solana", poolName: "FIGHT / SOL", volume24hUsd: 1536288.9, reserveUsd: 41852.4, priceChange24hPercent: 381.8, url: "https://www.geckoterminal.com/solana/pools/pool1" },
    ]);
    const c = clock();
    const f = fakeFetch([[/trending_pools/, () => json(pools)]]);
    await new GeckoTerminal("https://api.geckoterminal.com/api/v2", { fetchImpl: f.impl, sleep: c.sleep, now: c.now }).trendingPools();
    expect(new URL(f.calls[0]!.url).searchParams.get("include")).toBe("base_token");
  });
});

describe("Hacker News", () => {
  test("searches each distinct keyword without typos and sums the hits", async () => {
    expect(hnTerms(["$PLTR", "Palantir", "palantir", "Palantir Technologies", "Karp", "x"])).toEqual(["Palantir", "Palantir Technologies", "Karp"]);
    const c = clock();
    const f = fakeFetch([[/search_by_date/, (u) => json({ hits: [], nbHits: new URL(u).searchParams.get("query") === "Starlink" ? 11 : 4 })]]);
    const hn = new HackerNews("https://hn.algolia.com/api/v1", { fetchImpl: f.impl, sleep: c.sleep, now: c.now });
    expect(await hn.mentions(["Starlink", "SpaceX spectrum", "$SPCX"], 1_791_768_000)).toBe(15);
    const url = new URL(f.calls[0]!.url);
    expect([url.searchParams.get("numericFilters"), url.searchParams.get("hitsPerPage"), url.searchParams.get("typoTolerance")]).toEqual(["created_at_i>1791768000", "1", "false"]);
    await expect(hn.mentions(["$SOL"], 0)).rejects.toThrow("no keyword");
  });
});
