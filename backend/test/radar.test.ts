import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Ai, type Provider } from "../src/ai/providers";
import type { Sql } from "../src/db";
import { DEFAULT_RADAR, Radar, SOURCE_ATTRIBUTION } from "../src/radar";
import { Bluesky } from "../src/sources/bluesky";
import { CoinGecko } from "../src/sources/coingecko";
import { GeckoTerminal } from "../src/sources/geckoterminal";
import { Wikipedia } from "../src/sources/wikipedia";
import { Store } from "../src/store";
import { fakeFetch, json, quietLog, testDb } from "./helpers";

let sql: Sql;
let store: Store;
beforeAll(async () => {
  sql = await testDb();
  store = new Store(sql);
});
afterAll(async () => {
  await sql.end();
});

/** Answers every signal: a ticker in the line makes it crypto, anything else a topic. */
const prompts: string[] = [];
const assessor: Provider = {
  name: "fake",
  generate: async (_system, user) => {
    prompts.push(user);
    const lines = user.split("\n").filter((l) => /^\d+\. /.test(l));
    return {
      items: lines.map((line) => {
        const index = Number(line.split(".")[0]);
        const ticker = /\$([A-Z0-9]+)/.exec(line)?.[1] ?? null;
        return {
          index,
          trend_worthy: true,
          duplicate_of: null,
          asset_class: ticker ? "crypto" : "topic",
          slug: ticker ? ticker.toLowerCase() : `topic-${index}`,
          display_name: ticker ?? `Topic ${index}`,
          keywords: ticker ? [`$${ticker}`] : [`Topic ${index}`],
          wikipedia_article: null,
          ticker,
          summary: "s",
          policy_flags: [],
          confidence: 0.9,
        };
      }),
    };
  },
};

const coins = {
  coins: [
    { item: { id: "near", name: "NEAR Protocol", symbol: "NEAR", market_cap_rank: 20, score: 0 } },
    { item: { id: "pengu", name: "Pudgy Penguins", symbol: "PENGU", market_cap_rank: 121, score: 1 } },
  ],
};
const pool = (symbol: string, volume: number, reserve: number) => ({
  id: `solana_${symbol}`,
  type: "pool",
  attributes: { address: symbol, name: `${symbol} / SOL`, reserve_in_usd: String(reserve), volume_usd: { h24: String(volume) } },
  relationships: { base_token: { data: { id: `solana_t_${symbol}` } }, network: { data: { id: "solana" } } },
});
const tokens = (symbols: string[]) => symbols.map((s) => ({ id: `solana_t_${s}`, type: "token", attributes: { symbol: s, name: `${s} token` } }));
const pools = {
  // NEAR repeats CoinGecko's pick; DUST is too thin; TINY trades too little.
  data: [pool("NEAR", 5e6, 1e6), pool("FIGHT", 2e6, 5e5), pool("DUST", 9e6, 5e3), pool("TINY", 1e5, 5e5)],
  included: tokens(["NEAR", "FIGHT", "DUST", "TINY"]),
};
const trends = {
  trends: [
    { topic: "a1", displayName: "Cooling story", postCount: 90_000, status: "cooling", category: "politics" },
    { topic: "b2", displayName: "Rising story", postCount: 300, status: "trending", category: "sports", link: "/profile/x/feed/b2" },
  ],
};

describe("radar with free sources", () => {
  test("reads CoinGecko, GeckoTerminal and Bluesky, one signal per ticker, and records each source", async () => {
    const f = fakeFetch([
      [/search\/trending/, () => json(coins)],
      [/trending_pools/, () => json(pools)],
      [/getTrends/, () => json(trends)],
      [/pageviews\/top/, () => json({ items: [{ articles: [] }] })],
    ]);
    const quick = { fetchImpl: f.impl, sleep: async () => {} };
    const ai = new Ai([assessor]);
    const wikipedia = new Wikipedia("Bot/1.0 (https://example.org)", "en.wikipedia", f.impl, { sleep: async () => {} });
    const radar = new Radar(store, null, wikipedia, ai, { ...DEFAULT_RADAR, narrativesEvery: 1, autoApproveConfidence: 0.8 }, quietLog, {
      bluesky: new Bluesky("https://api.bsky.app", quick),
      coingecko: new CoinGecko("https://api.coingecko.com/api/v3", quick),
      geckoterminal: new GeckoTerminal("https://api.geckoterminal.com/api/v2", quick),
    });
    const report = await radar.tick(Date.parse("2026-10-13T12:00:00Z"));
    expect(report.skipped).toEqual(["no Elfa key"]);
    // NEAR, PENGU from CoinGecko; FIGHT from GeckoTerminal; two Bluesky topics.
    expect(report.signals).toBe(5);
    expect(report.approved).toBe(5);
    const rows = await store.candidates("approved", 50);
    const bySource = (s: string) => rows.filter((r) => r.source === s).map((r) => r.identifier).sort();
    expect(bySource("coingecko_trending")).toEqual(["crypto:near", "crypto:pengu"]);
    expect(bySource("geckoterminal_trending")).toEqual(["crypto:fight"]);
    expect(bySource("bluesky_trend")).toHaveLength(2);
    // Rising topics come before busier cooling ones, and outside text stays fenced.
    const prompt = prompts.join("\n");
    expect(prompt.indexOf("Rising story")).toBeLessThan(prompt.indexOf("Cooling story"));
    expect(prompt).toContain('CoinGecko most-searched coin $NEAR (market cap rank 20): <untrusted>{"name":"NEAR Protocol"}</untrusted>');
    expect(prompt).toContain("GeckoTerminal trending DEX pool on solana $FIGHT ($2.0M DEX volume in 24h)");
    expect(rows.find((r) => r.source === "bluesky_trend" && r.sourceRef.signal && (r.sourceRef.signal as { link?: string }).link)?.sourceRef).toMatchObject({
      signal: { kind: "social", platform: "bluesky", text: "Rising story", link: "https://bsky.app/profile/x/feed/b2" },
    });

    // The next run assesses nothing again, and CoinGecko is not asked twice within ten minutes.
    const before = f.calls.filter((c) => c.url.includes("coingecko")).length;
    expect((await radar.tick(Date.parse("2026-10-13T12:05:00Z"))).assessed).toBe(0);
    expect(f.calls.filter((c) => c.url.includes("coingecko")).length).toBe(before);
  });

  test("a feed that fails is skipped, the rest carry on", async () => {
    const f = fakeFetch([
      [/search\/trending/, () => new Response("bad", { status: 400 })],
      [/getTrends/, () => json(trends)],
      [/pageviews\/top/, () => json({ items: [{ articles: [] }] })],
    ]);
    const quick = { fetchImpl: f.impl, sleep: async () => {} };
    const wikipedia = new Wikipedia("Bot/1.0 (https://example.org)", "en.wikipedia", f.impl, { sleep: async () => {} });
    const radar = new Radar(store, null, wikipedia, new Ai([assessor]), { ...DEFAULT_RADAR, narrativesEvery: 1, autoApproveConfidence: 0.8 }, quietLog, {
      bluesky: new Bluesky("https://api.bsky.app", quick),
      coingecko: new CoinGecko("https://api.coingecko.com/api/v3", quick),
    });
    const report = await radar.tick(Date.parse("2026-10-14T12:00:00Z"));
    expect(report.skipped.some((s) => s.startsWith("coingecko trending: coingecko: HTTP 400"))).toBe(true);
    expect(report.signals).toBe(2);
  });

  test("candidates from CoinGecko's lists carry its attribution", () => {
    expect(SOURCE_ATTRIBUTION.coingecko_trending).toEqual({ text: "Data from CoinGecko", url: "https://www.coingecko.com" });
    expect(SOURCE_ATTRIBUTION.geckoterminal_trending?.text).toBe("Data from GeckoTerminal");
    expect(SOURCE_ATTRIBUTION.bluesky_trend).toBeUndefined();
  });
});
