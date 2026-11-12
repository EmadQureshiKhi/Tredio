import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyRing, THROTTLED_KEY_MS } from "../src/budget";
import type { Sql } from "../src/db";
import { Elfa } from "../src/sources/elfa";
import { GDELT_FIRST_REST_MS, GDELT_FIRST_SOURCE_REST_MS, GDELT_MAX_GAP_MS, GDELT_MAX_REST_MS, Gdelt, GdeltEmpty, gdeltDate, gdeltQuery, parseTimeline } from "../src/sources/gdelt";
import { BudgetError } from "../src/sources/http";
import { Nansen, netflowBody, parseNetflow } from "../src/sources/nansen";
import { hasContact, Wikipedia } from "../src/sources/wikipedia";
import { fakeFetch, json, testDb } from "./helpers";

let sql: Sql;
beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
const day = () => new Date("2026-10-10T12:00:00Z");

describe("Elfa", () => {
  test("reads mentions over a day-long window and charges one credit", async () => {
    const ring = new KeyRing(sql, "elfa-a", ["k1"], { daily: 10 }, day);
    const f = fakeFetch([[/keyword-mentions/, () => json({ success: true, data: [], metadata: { total: 119 } })]]);
    expect(await new Elfa(ring, "https://api.elfa.ai", f.impl).mentions(["bitcoin", "$BTC"], 0, 86_400)).toBe(119);
    const url = new URL(f.calls[0]!.url);
    expect(url.searchParams.get("keywords")).toBe("bitcoin,$BTC");
    expect((f.calls[0]!.init?.headers as Record<string, string>)["x-elfa-api-key"]).toBe("k1");
    expect((await ring.usage())[0]!.today).toBe(1);
  });

  test("refuses windows Elfa would reject", async () => {
    const ring = new KeyRing(sql, "elfa-b", ["k1"], { daily: 10 }, day);
    await expect(new Elfa(ring, "https://api.elfa.ai", fakeFetch([]).impl).mentions(["x"], 0, 3600)).rejects.toThrow("at least one day");
  });

  test("moves to the next key when Elfa refuses one for quota, and stops when all are spent", async () => {
    const ring = new KeyRing(sql, "elfa-c", ["k1", "k2"], { daily: 10 }, day);
    const f = fakeFetch([
      [
        /trending-narratives/,
        (_u, init) =>
          (init?.headers as Record<string, string>)["x-elfa-api-key"] === "k1"
            ? json({ error: "Monthly credit limit exceeded" }, 429)
            : json({ success: true, data: { trending_narratives: [{ narrative: "N", source_links: ["https://x.com/a/status/1", 3] }] } }),
      ],
    ]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl);
    // Whichever key goes first, the call succeeds; narratives cost five credits.
    expect(await elfa.trendingNarratives()).toEqual([{ narrative: "N", links: ["https://x.com/a/status/1"] }]);
    const spent = new KeyRing(sql, "elfa-d", ["k1"], { daily: 4 }, day);
    await expect(new Elfa(spent, "https://api.elfa.ai", f.impl).trendingNarratives()).rejects.toBeInstanceOf(BudgetError);
  });

  test("benches a key Elfa rejects as invalid and carries on with the others", async () => {
    const t = new Date("2026-10-10T12:00:00Z");
    const ring = new KeyRing(sql, "elfa-f", ["dead", "live"], { daily: 10 }, () => t);
    const keyOf = (init?: RequestInit) => (init?.headers as Record<string, string>)["x-elfa-api-key"];
    const f = fakeFetch([
      [/key-status/, (_u, init) => (keyOf(init) === "dead" ? json({ code: "ERR_UNAUTHORIZED", message: "Invalid or expired API key" }, 401) : json({ data: { usage: { monthly: 3 } } }))],
      [/keyword-mentions/, (_u, init) => (keyOf(init) === "dead" ? json({ code: "ERR_UNAUTHORIZED", message: "Invalid or expired API key" }, 401) : json({ success: true, data: [], metadata: { total: 7 } }))],
    ]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl);
    const ids = (await ring.usage()).map((u) => u.keyId);
    // The sync reports the rejected key and still records the good key's usage.
    expect(await elfa.syncUsage([{ key: "dead", keyId: ids[0]! }, { key: "live", keyId: ids[1]! }])).toEqual({ rejected: [ids[0]!], failed: [] });
    expect((await ring.usage())[1]!.month).toBe(3);
    // Every later call goes to the live key, with no request to the rejected one.
    const before = f.calls.length;
    for (let i = 0; i < 3; i++) expect(await elfa.mentions(["x"], 0, 86_400)).toBe(7);
    expect(f.calls.slice(before).every((c) => keyOf(c.init) === "live")).toBe(true);
  });

  test("rests a key Elfa throttles with a plain 429 and moves the call to the next key", async () => {
    let t = new Date("2026-10-10T12:00:00Z");
    const ring = new KeyRing(sql, "elfa-g", ["slow", "fast"], { daily: 10 }, () => t);
    const keyOf = (init?: RequestInit) => (init?.headers as Record<string, string>)["x-elfa-api-key"];
    const f = fakeFetch([[/keyword-mentions/, (_u, init) => (keyOf(init) === "slow" ? json({ message: "Too Many Requests" }, 429) : json({ success: true, data: [], metadata: { total: 2 } }))]]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl);
    for (let i = 0; i < 3; i++) expect(await elfa.mentions(["x"], 0, 86_400)).toBe(2);
    // The throttled key was asked at most once, then rested.
    expect(f.calls.filter((c) => keyOf(c.init) === "slow").length).toBeLessThanOrEqual(1);
    t = new Date(t.getTime() + THROTTLED_KEY_MS + 1);
    const before = f.calls.length;
    for (let i = 0; i < 4; i++) await elfa.mentions(["x"], 0, 86_400);
    expect(f.calls.slice(before).some((c) => keyOf(c.init) === "slow")).toBe(true);
  });

  test("parses trending tokens and strips the cashtag", async () => {
    const ring = new KeyRing(sql, "elfa-e", ["k1"], { daily: 10 }, day);
    const f = fakeFetch([
      [/trending-tokens/, () => json({ success: true, data: { data: [{ token: "$strk", current_count: 300, previous_count: 100, change_percent: 200 }, { token: 5 }] } })],
    ]);
    expect(await new Elfa(ring, "https://api.elfa.ai", f.impl).trendingTokens()).toEqual([{ token: "strk", currentCount: 300, previousCount: 100, changePercent: 200 }]);
  });
});

describe("Nansen", () => {
  test("sums flows per ticker across chains", () => {
    const flows = parseNetflow({
      data: [
        { token_symbol: "eth", net_flow_24h_usd: 100 },
        { token_symbol: "ETH", net_flow_24h_usd: -40 },
        { token_symbol: "STRK", net_flow_24h_usd: 5 },
        { token_symbol: "WBTC", net_flow_24h_usd: 7 },
        { token_symbol: "cbBTC", net_flow_24h_usd: 3 },
        { token_symbol: "BAD", net_flow_24h_usd: "x" },
      ],
    });
    expect([...flows]).toEqual([
      ["ETH", 60],
      ["STRK", 5],
      ["BTC", 10],
    ]);
  });

  test("asks for the most-traded tokens without a ticker filter", () => {
    const body = netflowBody(["all"]);
    expect(body.filters).not.toHaveProperty("token_address");
    expect(body.pagination.per_page).toBe(1000);
  });

  test("rests a key whose reported balance cannot pay for another call", async () => {
    const ring = new KeyRing(sql, "nansen-a", ["n1", "n2"], { daily: 10 }, day);
    const f = fakeFetch([[/netflow/, () => json({ data: [] }, 200, { "x-nansen-credits-remaining": "3" })]]);
    const nansen = new Nansen(ring, "https://api.nansen.ai", ["all"], f.impl);
    await nansen.netflow();
    const first = (f.calls[0]!.init?.headers as Record<string, string>).apikey;
    await nansen.netflow();
    expect((f.calls[1]!.init?.headers as Record<string, string>).apikey).not.toBe(first);
    await expect(nansen.netflow()).rejects.toBeInstanceOf(BudgetError);
  });

  test("benches a key Nansen rejects and one out of quota, and carries on with the rest", async () => {
    const ring = new KeyRing(sql, "nansen-b", ["dead", "broke", "live"], { daily: 100 }, day);
    const f = fakeFetch([
      [
        /netflow/,
        (_u, init) => {
          const key = (init?.headers as Record<string, string>).apikey;
          if (key === "dead") return json({ message: "Invalid API key" }, 401);
          if (key === "broke") return json({ message: "Insufficient credits" }, 402);
          return json({ data: [{ token_symbol: "ETH", net_flow_24h_usd: 1 }] });
        },
      ],
    ]);
    const nansen = new Nansen(ring, "https://api.nansen.ai", ["all"], f.impl);
    for (let i = 0; i < 4; i++) expect([...(await nansen.netflow())]).toEqual([["ETH", 1]]);
    const asked = f.calls.map((c) => (c.init?.headers as Record<string, string>).apikey);
    expect(asked.filter((k) => k === "dead")).toHaveLength(1);
    expect(asked.filter((k) => k === "broke")).toHaveLength(1);
  });
});

describe("GDELT", () => {
  const timeline = (values: number[], norms?: number[], start = Date.UTC(2026, 9, 12, 4, 15) / 1000) => ({
    timeline: [
      {
        series: "Article Count",
        data: values.map((value, i) => {
          const d = new Date((start + i * 900) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
          return norms ? { date: d, value, norm: norms[i] } : { date: d, value };
        }),
      },
    ],
  });
  const ok = () => json({ timeline: [{ data: [{ value: 1 }] }] });
  const plea = () => new Response("Please limit requests to one every 5 seconds", { status: 429 });
  const clock = () => {
    const c = { t: 1_000_000, waits: [] as number[] };
    return { c, sleep: async (ms: number) => void (c.waits.push(ms), (c.t += ms)), now: () => c.t };
  };

  test("builds an OR query of news-worthy keywords", () => {
    expect(gdeltQuery(["$STRK", "Starknet"])).toBe("Starknet");
    expect(gdeltQuery(["SpaceX spectrum", "Starlink", "Starlink", "AI"])).toBe('("SpaceX spectrum" OR Starlink)');
    expect(gdeltQuery(["$BTC", "BT"])).toBeNull();
  });

  test("sums the timeline, and never turns an empty or stale answer into zero", () => {
    expect(parseTimeline('{"timeline":[{"series":"Article Count","data":[{"value":3},{"value":4},{"value":"x"}]}]}')).toBe(7);
    const at = Date.UTC(2026, 9, 12, 5, 0) / 1000;
    expect(parseTimeline(JSON.stringify(timeline([1, 0, 2], [500, 480, 510])), at)).toBe(3);
    // A day where nothing matched, while GDELT kept monitoring, is a real zero.
    expect(parseTimeline(JSON.stringify(timeline([0, 0, 0], [500, 480, 510])), at)).toBe(0);
    expect(() => parseTimeline("{}")).toThrow(GdeltEmpty);
    expect(() => parseTimeline('{"timeline":[]}')).toThrow(GdeltEmpty);
    // GDELT's index monitored nothing all day, or stopped hours before the window ends.
    expect(() => parseTimeline(JSON.stringify(timeline([0, 0, 0], [0, 0, 0])), at)).toThrow("no articles monitored");
    const behind = timeline(Array(40).fill(0), [300, 300, ...Array(38).fill(0)]);
    expect(() => parseTimeline(JSON.stringify(behind), at + 10 * 3600)).toThrow("behind");
    expect(() => parseTimeline("Please limit requests")).toThrow("Please limit");
    // A timeline that ends days ago: GDELT's index stopped there.
    expect(parseTimeline(JSON.stringify(timeline([1, 2], [9, 9])), at)).toBe(3);
    expect(() => parseTimeline(JSON.stringify(timeline([1, 2], [9, 9])), at + 3 * 86_400)).toThrow("behind");
    expect(gdeltDate("20261013T041500Z")).toBe(Date.UTC(2026, 9, 13, 4, 15) / 1000);
  });

  test("paces one request at a time, a jittered 6 to 10 s after the previous answer ended", async () => {
    const { c, sleep, now } = clock();
    const f = fakeFetch([[/gdeltproject/, ok]]);
    const jitter = [0, 0.5, 0.999];
    const starts: number[] = [];
    const g = new Gdelt(
      async (input, init) => {
        starts.push(c.t);
        c.t += 20_000; // a slow answer
        return f.impl(input, init);
      },
      sleep,
      now,
      { random: () => jitter.shift() ?? 0 },
    );
    await Promise.all([g.articles(["Starlink"]), g.articles(["Starlink"]), g.articles(["Starlink"])]);
    expect(c.waits).toEqual([6_000, 8_000]);
    // Concurrent callers never overlap: each start is at least 26 s after the one before.
    expect(starts[1]! - starts[0]!).toBe(26_000);
    expect(starts[2]! - starts[1]!).toBe(28_000);
  });

  test("rests after a 429 for its Retry-After or a backoff that doubles to an hour, and a reading resets it", async () => {
    const { c, sleep, now } = clock();
    let answer: () => Response = () => new Response("slow down", { status: 429, headers: { "retry-after": "600" } });
    const g = new Gdelt(async () => answer(), sleep, now, { random: () => 0 });
    await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    expect(g.available).toBe(false);
    await expect(g.articles(["Starlink"])).rejects.toThrow("resting");
    c.t += 599_000;
    expect(g.available).toBe(false);
    c.t += 1_001;
    answer = plea;
    await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    // The backoff doubled to 4 minutes underneath the longer Retry-After.
    c.t += GDELT_FIRST_REST_MS * 2 - 1;
    expect(g.available).toBe(false);
    c.t += 1;
    expect(g.available).toBe(true);
    answer = ok;
    expect(await g.articles(["Starlink"])).toBe(1);
    answer = plea;
    await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    c.t += GDELT_FIRST_REST_MS;
    expect(g.available).toBe(true);
    // The backoff never passes an hour.
    for (let i = 0; i < 10; i++) {
      await expect(g.articles(["Starlink"])).rejects.toThrow("429");
      c.t = g.restingUntil;
    }
    await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    expect(g.restingUntil - c.t).toBeLessThanOrEqual(GDELT_MAX_REST_MS + GDELT_MAX_GAP_MS);
    expect(g.counts.refused).toBe(14);
  });

  test("treats GDELT's plain-text plea with a 200 as a throttle", async () => {
    const { sleep, now } = clock();
    const g = new Gdelt(async () => new Response("Please limit requests to one every 5 seconds", { status: 200 }), sleep, now);
    await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    expect(g.available).toBe(false);
  });

  test("an empty answer is no reading, and empty answers in a row rest the lane", async () => {
    const { c, sleep, now } = clock();
    let answer = () => json({});
    const g = new Gdelt(async () => answer(), sleep, now, { random: () => 0 });
    expect(await g.articles(["Starlink"])).toBeNull();
    expect(g.available).toBe(true);
    expect(await g.articles(["Starlink"])).toBeNull();
    expect(g.available).toBe(false);
    c.t += GDELT_FIRST_REST_MS + 1;
    answer = ok;
    expect(await g.articles(["Starlink"])).toBe(1);
    answer = () => json({});
    expect(await g.articles(["Starlink"])).toBeNull();
    expect(g.available).toBe(true);
  });

  test("keeps to the first lane, takes the others in turn while it rests, and skips lanes that are not ready", async () => {
    const { c, sleep, now } = clock();
    const used: string[] = [];
    const refuse = new Set<string>(["direct"]);
    const lane = (id: string, ready = () => true) => ({
      id,
      ready,
      fetch: async () => {
        used.push(id);
        return refuse.has(id) ? plea() : ok();
      },
    });
    let bReady = false;
    const g = new Gdelt(undefined, sleep, now, { random: () => 0, lanes: [lane("direct"), lane("a"), lane("b", () => bReady), lane("c")] });
    await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    for (let i = 0; i < 3; i++) await g.articles(["Starlink"]);
    bReady = true;
    for (let i = 0; i < 3; i++) await g.articles(["Starlink"]);
    expect(used).toEqual(["direct", "a", "c", "a", "b", "c", "a"]);
    // Back on the first lane once its rest is over.
    c.t += GDELT_FIRST_REST_MS;
    refuse.clear();
    await g.articles(["Starlink"]);
    expect(used.at(-1)).toBe("direct");
    // Refused on three lanes in a row, GDELT itself is shedding load: the whole source rests.
    refuse.add("direct").add("a").add("b").add("c");
    const before = used.length;
    for (let i = 0; i < 3; i++) await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    expect(new Set(used.slice(before))).toEqual(new Set(["direct", "b", "c"]));
    expect(g.available).toBe(false);
    await expect(g.articles(["Starlink"])).rejects.toThrow("resting");
    expect(used.length).toBe(before + 3);
    expect(g.restingUntil - c.t).toBe(GDELT_FIRST_SOURCE_REST_MS);
    c.t += GDELT_FIRST_SOURCE_REST_MS;
    expect(g.available).toBe(true);
    // A reading ends the streak; until then each further streak rests the source twice as long.
    for (let i = 0; i < 3; i++) await expect(g.articles(["Starlink"])).rejects.toThrow("429");
    expect(g.restingUntil - c.t).toBeGreaterThanOrEqual(GDELT_FIRST_SOURCE_REST_MS * 2 - GDELT_MAX_GAP_MS * 3);
  });
});

describe("Wikipedia", () => {
  test("recognizes a compliant User-Agent", () => {
    expect(hasContact("Bot/1.0 (https://example.org; ops@example.org)")).toBe(true);
    expect(hasContact("Bot/1.0 (ops@example.org)")).toBe(true);
    expect(hasContact("Bot/1.0 (attention index)")).toBe(false);
  });

  test("paces every call under the unidentified limit and honors Retry-After", async () => {
    let t = 0;
    const waits: number[] = [];
    const f = fakeFetch([
      [/per-article\/en\.wikipedia\/all-access\/user\/Starlink\/daily\/2026100900/, () => json({ items: [{ views: 1200 }] })],
      [/per-article.*Missing/, () => json({ title: "Not found." }, 404)],
      [/page\/summary\/Mercury/, () => json({ type: "disambiguation", titles: { canonical: "Mercury" } })],
      [/top\/en\.wikipedia/, () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } })],
    ]);
    const w = new Wikipedia("Bot/1.0 (no contact)", "en.wikipedia", f.impl, {
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
      now: () => t,
    });
    const yesterday = new Date("2026-10-09T00:00:00Z");
    expect(await w.pageviews("Starlink", yesterday)).toBe(1200);
    expect(await w.pageviews("Missing", yesterday)).toBeNull();
    expect(await w.canonicalTitle("Mercury")).toBeNull();
    await expect(w.topArticles(yesterday)).rejects.toThrow("429");
    await w.pageviews("Starlink", yesterday);
    // 8 a minute: 7.5 s apart, then the 30 s Retry-After.
    expect(waits).toEqual([7_500, 7_500, 7_500, 30_000]);
  });

  test("reads the day before while yesterday is not published, never a zero for it", async () => {
    // Shortly after UTC midnight Wikimedia still answers 404 for the day that just ended.
    const f = fakeFetch([
      [/per-article\/en\.wikipedia\/all-access\/user\/Starlink\/daily\/2026101100/, () => json({ title: "Not found." }, 404)],
      [/per-article\/en\.wikipedia\/all-access\/user\/Starlink\/daily\/2026101000/, () => json({ items: [{ views: 73_306 }] })],
      [/per-article.*Missing/, () => json({ title: "Not found." }, 404)],
    ]);
    const w = new Wikipedia("Bot/1.0 (https://example.org)", "en.wikipedia", f.impl, { sleep: async () => {} });
    const justAfterMidnight = Date.parse("2026-10-12T02:17:00Z");
    expect(await w.latestPageviews("Starlink", justAfterMidnight)).toBe(73_306);
    expect(await w.latestPageviews("Missing", justAfterMidnight)).toBe(0);
  });

  test("drops non-topics from the most-read list", async () => {
    const f = fakeFetch([
      [
        /top\/en\.wikipedia\/all-access\/2026\/10\/09/,
        () =>
          json({
            items: [{ articles: [{ article: "Main_Page", views: 9, rank: 1 }, { article: "Special:Search", views: 8, rank: 2 }, { article: "Deaths_in_2026", views: 7, rank: 3 }, { article: "Starlink", views: 6, rank: 4 }] }],
          }),
      ],
    ]);
    const w = new Wikipedia("Bot/1.0 (https://example.org)", "en.wikipedia", f.impl);
    expect(await w.topArticles(new Date("2026-10-09T00:00:00Z"))).toEqual([{ article: "Starlink", views: 6, rank: 4 }]);
  });
});
