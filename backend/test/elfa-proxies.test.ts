import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { KeyRing, keyId } from "../src/budget";
import type { Sql } from "../src/db";
import { GLOBAL_PROXY_VARS, loadConfig } from "../src/config";
import { Bluesky } from "../src/sources/bluesky";
import { CoinGecko } from "../src/sources/coingecko";
import { Elfa, elfaProxy, PlanError, PROXY_AUTH_REST_MS, parseKeyStatus } from "../src/sources/elfa";
import { GeckoTerminal } from "../src/sources/geckoterminal";
import { HackerNews } from "../src/sources/hackernews";
import { Polite } from "../src/sources/polite";
import { KEYLESS_FALLBACK_HOSTS, ProxyFallback } from "../src/sources/proxy-pool";
import { maskKey, proxyHost, routeElfaKeys } from "../src/sources/elfa-proxies";
import { BudgetError } from "../src/sources/http";
import { fakeFetch, json, testDb } from "./helpers";

let sql: Sql;
beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
const at = new Date("2026-10-13T12:00:00Z");
const keyOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.["x-elfa-api-key"];
const proxyOf = (init?: RequestInit) => (init as { proxy?: string } | undefined)?.proxy;
const mentionsOk = () => json({ success: true, data: [], metadata: { total: 3 } });

describe("Elfa key routing", () => {
  test("pins key i to route i, one to one, and leaves keys without a route of their own unused", () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key-${String(i).padStart(4, "0")}`);
    const proxies = Array.from({ length: 10 }, (_, i) => `http://user-${i}:secret@10.0.0.${i}:600${i}`);
    const r = routeElfaKeys(keys, proxies);
    expect(r.routes.map((x) => [x.key, x.proxy])).toEqual(keys.slice(0, 10).map((k, i) => [k, proxies[i]!]));
    expect(new Set(r.routes.map((x) => x.proxy)).size).toBe(10);
    expect(r.skipped).toEqual(["...0010", "...0011"]);
    // The mapping a log may carry holds no key and no password.
    expect(r.mapping[0]).toEqual({ key: "...0000", proxy: "10.0.0.0:6000 (user ...er-0)" });
    expect(JSON.stringify([r.mapping, r.skipped, r.unused])).not.toContain("secret");
    expect(JSON.stringify(r.mapping)).not.toContain("key-");
    expect(routeElfaKeys(["a1234"], ["http://u:p@h:1", "http://u:p@h:2"]).unused).toEqual(["h:2 (user ...u)"]);
    // No route at all: no key is used.
    expect(routeElfaKeys(["k-aaaa"], [])).toMatchObject({ routes: [], skipped: ["...aaaa"] });
  });

  test("refuses two entries naming the same route, and malformed ones, by position, never echoing them", () => {
    expect(() => routeElfaKeys(["a", "b"], ["http://u:p@h:1", "http://u:other@h:1"])).toThrow("ELFA_PROXIES entries 1 and 2 are the same proxy");
    expect(() => routeElfaKeys(["k"], ["socks5://u:hunter2@h:1"])).toThrow("ELFA_PROXIES entry 1 must be an http:// or https:// proxy");
    expect(() => routeElfaKeys(["k"], ["http://u:p@h:1", "hunter2"])).toThrow(/^ELFA_PROXIES entry 2 is not a URL/);
    expect(proxyHost("http://u:p@p.example.net")).toBe("p.example.net:80 (user ...u)");
    expect(proxyHost("not a url")).toBe("invalid proxy");
    expect(maskKey("abcdef123456")).toBe("...3456");
  });
});

describe("Elfa routes carry Elfa requests only", () => {
  test("a route is attached only to a request for the Elfa API's host", () => {
    expect(elfaProxy("api.elfa.ai", "https://api.elfa.ai/v2/key-status", "http://u:p@px:1")).toEqual({ proxy: "http://u:p@px:1" });
    expect(elfaProxy("api.elfa.ai", "https://api.bsky.app/xrpc/x", null)).toEqual({});
    for (const other of ["https://api.bsky.app/xrpc/x", "https://api.elfa.ai.evil.example/v2", "https://elfa.ai/v2", "https://api.coingecko.com/api/v3/search/trending"]) {
      expect(() => elfaProxy("api.elfa.ai", other, "http://u:p@px:1")).toThrow("only ever carries requests to api.elfa.ai");
    }
  });

  test("a key without a route of its own is never used when routes are required", async () => {
    const ring = new KeyRing(sql, "elfa-px-g", ["bare", "pinned"], { daily: 30 }, () => at);
    const f = fakeFetch([[/keyword-mentions/, mentionsOk]]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, (id) => (id === keyId("pinned") ? "http://u:p@px:1" : null), true);
    for (let i = 0; i < 5; i++) await elfa.mentions(["x"], 0, 86_400);
    expect(f.calls.every((c) => keyOf(c.init) === "pinned" && proxyOf(c.init) === "http://u:p@px:1")).toBe(true);
    await expect(elfa.keyStatus("bare", keyId("bare"))).rejects.toThrow("no proxy of its own");
  });

  test("no other source sends a route, even when handed one", async () => {
    const f = fakeFetch([
      [/searchPosts/, () => json({ hitsTotal: 1 })],
      [/search_by_date/, () => json({ nbHits: 1 })],
      [/search\/trending/, () => json({ coins: [] })],
      [/trending_pools/, () => json({ data: [] })],
    ]);
    const quick = { fetchImpl: f.impl, sleep: async () => {} };
    await new Bluesky("https://api.bsky.app", quick).mentions(["Bitcoin"], 0, 86_400);
    await new HackerNews("https://hn.algolia.com/api/v1", quick).mentions(["Bitcoin"], 0);
    await new CoinGecko("https://api.coingecko.com/api/v3", quick).trending();
    await new GeckoTerminal("https://api.geckoterminal.com/api/v2", quick).trendingPools();
    await new Polite("t", { spacingMs: 0, ...quick }).json("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts", { proxy: "http://u:p@px:1" } as RequestInit);
    expect(f.calls).toHaveLength(5);
    expect(f.calls.every((c) => proxyOf(c.init) === undefined)).toBe(true);
  });

  test("the backend refuses a process-wide proxy, and Elfa routes pointed anywhere but api.elfa.ai", () => {
    const base = { DATABASE_URL: "postgres://unused", ORACLE_TOKEN: "t".repeat(32) };
    for (const v of GLOBAL_PROXY_VARS) expect(() => loadConfig({ ...base, [v]: "http://u:p@px:1" })).toThrow(`${v} must be unset`);
    expect(() => loadConfig({ ...base, ELFA_PROXIES: "http://u:p@px:1", ELFA_API_BASE: "https://elfa.example.org" })).toThrow("api.elfa.ai only");
    expect(loadConfig({ ...base, ELFA_PROXIES: "http://u:p@px:1" }).ELFA_PROXIES).toHaveLength(1);
  });
});

describe("Elfa through routes", () => {
  test("every request of a key goes through that key's own route", async () => {
    const r = routeElfaKeys(["key-a", "key-b", "key-c"], ["http://u:p@one:1", "http://u:p@two:2", "http://u:p@three:3"]);
    const ring = new KeyRing(sql, "elfa-px-a", r.routes.map((x) => x.key), { daily: 30 }, () => at);
    const proxies = new Map(r.routes.map((x) => [x.keyId, x.proxy]));
    const f = fakeFetch([[/keyword-mentions/, mentionsOk]]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, (id) => proxies.get(id) ?? null);
    for (let i = 0; i < 9; i++) await elfa.mentions(["x"], 0, 86_400);
    const seen = new Map<string, Set<string | undefined>>();
    for (const c of f.calls) seen.set(keyOf(c.init)!, (seen.get(keyOf(c.init)!) ?? new Set()).add(proxyOf(c.init)));
    expect([...seen.keys()].sort()).toEqual(["key-a", "key-b", "key-c"]);
    expect([...seen.get("key-a")!]).toEqual(["http://u:p@one:1"]);
    expect([...seen.get("key-b")!]).toEqual(["http://u:p@two:2"]);
    expect([...seen.get("key-c")!]).toEqual(["http://u:p@three:3"]);
  });

  test("a failed route rests its key and the call moves on; a route refusing its credentials rests it longer", async () => {
    let t = at;
    const ring = new KeyRing(sql, "elfa-px-b", ["down", "auth", "fine"], { daily: 30 }, () => t);
    const proxies: Record<string, string> = { [keyId("down")]: "http://u:p@down:1", [keyId("auth")]: "http://u:p@auth:1", [keyId("fine")]: "http://u:p@fine:1" };
    const f = fakeFetch([
      [
        /keyword-mentions/,
        (_u, init) => {
          if (proxyOf(init) === "http://u:p@down:1") throw new Error("Unable to connect. Is the computer able to access the url?");
          if (proxyOf(init) === "http://u:p@auth:1") return new Response("", { status: 407 });
          return mentionsOk();
        },
      ],
    ]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, (id) => proxies[id] ?? null);
    for (let i = 0; i < 4; i++) expect(await elfa.mentions(["x"], 0, 86_400)).toBe(3);
    // Each broken route was tried once, then its key sat out.
    expect(f.calls.filter((c) => keyOf(c.init) !== "fine").length).toBeLessThanOrEqual(2);
    t = new Date(at.getTime() + 10 * 60_000);
    const before = f.calls.length;
    await elfa.mentions(["x"], 0, 86_400).catch(() => 0);
    // Ten minutes on, the unreachable route's key is back; the one with bad credentials is not (PROXY_AUTH_REST_MS).
    expect(PROXY_AUTH_REST_MS).toBeGreaterThan(10 * 60_000);
    expect(f.calls.slice(before).some((c) => keyOf(c.init) === "auth")).toBe(false);
  });

  test("keys Elfa rejects all sit out, and no call goes out until they are due again", async () => {
    const ring = new KeyRing(sql, "elfa-px-c", ["dead1", "dead2"], { daily: 30 }, () => at);
    const f = fakeFetch([[/elfa/, () => json({ code: "ERR_UNAUTHORIZED", message: "Invalid or expired API key" }, 401)]]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl, () => "http://u:p@px:1");
    expect(await elfa.syncUsage([{ key: "dead1", keyId: keyId("dead1") }, { key: "dead2", keyId: keyId("dead2") }])).toEqual({ rejected: [keyId("dead1"), keyId("dead2")], failed: [] });
    expect(elfa.keysBenched).toBe(true);
    const calls = f.calls.length;
    await expect(elfa.mentions(["x"], 0, 86_400)).rejects.toBeInstanceOf(BudgetError);
    expect(f.calls.length).toBe(calls);
  });

  test("reaches Elfa through a real HTTP proxy with the proxy's credentials", async () => {
    const seen: Array<{ url?: string; auth?: string; key?: string }> = [];
    const proxy: Server = createServer((req, res) => {
      // A forward proxy for plain http: the request line carries the absolute URL.
      seen.push({ url: req.url, auth: req.headers["proxy-authorization"], key: req.headers["x-elfa-api-key"] as string | undefined });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: [], metadata: { total: 42 } }));
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    try {
      const port = (proxy.address() as { port: number }).port;
      const r = routeElfaKeys(["real-key"], [`http://route-user:p%40ss@127.0.0.1:${port}`]);
      const ring = new KeyRing(sql, "elfa-px-d", ["real-key"], { daily: 10 }, () => at);
      const elfa = new Elfa(ring, "http://elfa.test", fetch, () => r.routes[0]!.proxy);
      expect(await elfa.mentions(["Bitcoin"], 0, 86_400)).toBe(42);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toStartWith("http://elfa.test/v2/data/keyword-mentions?");
      expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("route-user:p@ss").toString("base64")}`);
      expect(seen[0]!.key).toBe("real-key");
    } finally {
      proxy.close();
    }
  });
});

describe("Elfa narratives on free keys", () => {
  test("a key Elfa reports as free never asks for narratives", async () => {
    const ring = new KeyRing(sql, "elfa-px-e", ["free1"], { daily: 30 }, () => at);
    const f = fakeFetch([[/key-status/, () => json({ success: true, data: { plan: "Free", usage: { monthly: 120 }, monthlyRequestLimit: 1000 } })]]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl);
    await elfa.syncUsage([{ key: "free1", keyId: keyId("free1") }]);
    expect(elfa.narrativesAvailable).toBe(false);
    await expect(elfa.trendingNarratives()).rejects.toBeInstanceOf(PlanError);
    expect(f.calls.some((c) => c.url.includes("trending-narratives"))).toBe(false);
    expect((await ring.usage())[0]!.month).toBe(120);
  });

  test("a plan refusal stops narratives for every key not known to be paid, after one request", async () => {
    const ring = new KeyRing(sql, "elfa-px-f", ["k1", "k2", "k3"], { daily: 30 }, () => at);
    const f = fakeFetch([
      [/trending-narratives/, () => json({ code: "ERR_FORBIDDEN", message: "This endpoint requires a paid plan" }, 403)],
      [/keyword-mentions/, mentionsOk],
    ]);
    const elfa = new Elfa(ring, "https://api.elfa.ai", f.impl);
    await expect(elfa.trendingNarratives()).rejects.toBeInstanceOf(PlanError);
    await expect(elfa.trendingNarratives()).rejects.toBeInstanceOf(PlanError);
    expect(f.calls.filter((c) => c.url.includes("trending-narratives"))).toHaveLength(1);
    expect(elfa.narrativesAvailable).toBe(false);
    // The keys themselves are fine for free endpoints.
    expect(await elfa.mentions(["x"], 0, 86_400)).toBe(3);
  });

  test("reads key status leniently", () => {
    expect(parseKeyStatus({ data: { plan: "Pro", usage: { monthly: 10 }, monthlyRequestLimit: 50_000 } })).toEqual({ plan: "Pro", free: false, usedThisMonth: 10, monthlyLimit: 50_000, remaining: 49_990 });
    expect(parseKeyStatus({ data: { usage: { monthly: 900 }, monthlyRequestLimit: 1000 } })).toMatchObject({ plan: null, free: true, remaining: 100 });
    expect(parseKeyStatus({ data: {} })).toEqual({ plan: null, free: null, usedThisMonth: null, monthlyLimit: null, remaining: null });
  });
});

describe("keyless fallback through the routes", () => {
  const proxies = ["http://u:p@px1:1", "http://u:p@px2:2"];
  const answer = (status: number) => () => new Response(status === 200 ? '{"ok":true}' : "no", { status });

  test("calls directly first, and only a 403 or 429 from a keyless source retries once through a route", async () => {
    const f = fakeFetch([
      [/api\.bsky\.app\/limited/, (_u, init) => (proxyOf(init) ? answer(200)() : answer(429)())],
      [/hn\.algolia\.com\/blocked/, (_u, init) => (proxyOf(init) ? answer(200)() : answer(403)())],
      [/api\.coingecko\.com\/broken/, answer(500)],
      [/api\.geckoterminal\.com\/ok/, answer(200)],
    ]);
    const fetchVia = new ProxyFallback(proxies).wrap(f.impl);
    expect((await fetchVia("https://api.bsky.app/limited")).status).toBe(200);
    expect(f.calls.map((c) => proxyOf(c.init))).toEqual([undefined, "http://u:p@px1:1"]);
    expect((await fetchVia("https://hn.algolia.com/blocked")).status).toBe(200);
    expect(proxyOf(f.calls[3]!.init)).toBe("http://u:p@px2:2");
    // Other failures, and successes, never touch a route, even when the caller passes one.
    expect((await fetchVia("https://api.coingecko.com/broken")).status).toBe(500);
    expect((await fetchVia("https://api.geckoterminal.com/ok", { proxy: proxies[0] } as RequestInit)).status).toBe(200);
    expect(f.calls.slice(4).every((c) => proxyOf(c.init) === undefined)).toBe(true);
  });

  test("never reaches anything but the listed keyless hosts through a route", async () => {
    const f = fakeFetch([[/./, answer(429)]]);
    const fetchVia = new ProxyFallback(proxies).wrap(f.impl);
    for (const url of [
      "https://api.openai.com/v1/chat/completions",
      "https://generativelanguage.googleapis.com/v1beta/models",
      "https://api.nansen.ai/api/v1/smart-money/netflow",
      "https://api.elfa.ai/v2/data/keyword-mentions",
      "https://api.example.org/v1/orders",
      "http://localhost:4100/v1/relay",
      "https://api.bsky.app.evil.example/xrpc",
    ]) {
      expect((await fetchVia(url)).status).toBe(429);
    }
    expect(f.calls.every((c) => proxyOf(c.init) === undefined)).toBe(true);
    expect([...KEYLESS_FALLBACK_HOSTS].sort()).toEqual(["api.bsky.app", "api.coingecko.com", "api.gdeltproject.org", "api.geckoterminal.com", "en.wikipedia.org", "hn.algolia.com", "wikimedia.org"]);
  });

  test("prefers a route whose Elfa key is idle", async () => {
    const f = fakeFetch([[/./, (_u, init) => (proxyOf(init) ? answer(200)() : answer(429)())]]);
    const fetchVia = new ProxyFallback(proxies, { busy: () => new Set([proxies[0]!]) }).wrap(f.impl);
    for (let i = 0; i < 3; i++) await fetchVia("https://api.bsky.app/x");
    expect(f.calls.filter((c) => proxyOf(c.init)).every((c) => proxyOf(c.init) === proxies[1])).toBe(true);
  });

  test("stops at the month's bandwidth cap and starts again next month", async () => {
    let now = Date.parse("2026-10-31T23:00:00Z");
    const big = "x".repeat(100_000);
    const f = fakeFetch([[/./, (_u, init) => (proxyOf(init) ? new Response(big) : answer(429)())]]);
    const pool = new ProxyFallback(proxies, { capBytes: 250_000, now: () => now });
    const fetchVia = pool.wrap(f.impl);
    expect((await fetchVia("https://wikimedia.org/a")).status).toBe(200);
    expect((await fetchVia("https://wikimedia.org/a")).status).toBe(200);
    // Two answers and their overhead leave no room for a third.
    expect((await fetchVia("https://wikimedia.org/a")).status).toBe(429);
    expect(pool.stats).toMatchObject({ month: "2026-10", requests: 2 });
    expect(pool.stats.bytes).toBeGreaterThan(200_000);
    now = Date.parse("2026-11-01T00:00:01Z");
    expect((await fetchVia("https://wikimedia.org/a")).status).toBe(200);
    expect(pool.stats).toMatchObject({ month: "2026-11", requests: 1 });
  });

  test("lanes for a paced client send only through their own entry, within a share of the cap, while its Elfa key is idle", async () => {
    const f = fakeFetch([[/./, () => new Response("x".repeat(40_000))]]);
    let busy = new Set<string>();
    const pool = new ProxyFallback(proxies, { capBytes: 200_000, busy: () => busy });
    const lanes = pool.lanes(f.impl, { share: 0.5 });
    expect(lanes.map((l) => l.id)).toEqual(["fallback-1", "fallback-2"]);
    expect(lanes.every((l) => l.ready())).toBe(true);
    busy = new Set([proxies[0]!]);
    expect(lanes.map((l) => l.ready())).toEqual([false, true]);
    await lanes[1]!.fetch("https://api.gdeltproject.org/api/v2/doc/doc?query=x", { proxy: "http://elsewhere:1" } as RequestInit);
    expect(proxyOf(f.calls[0]!.init)).toBe(proxies[1]);
    await lanes[1]!.fetch("https://api.gdeltproject.org/api/v2/doc/doc?query=x");
    // About 96 KB of the 100 KB share is spent: a third request would pass it.
    expect(lanes[1]!.ready()).toBe(false);
    expect(pool.stats.requests).toBe(2);
    // Never anything but the keyless hosts.
    await expect(lanes[1]!.fetch("https://api.elfa.ai/v2/data/keyword-mentions")).rejects.toThrow("not a keyless source");
  });

  test("a failing route's error never quotes its credentials", async () => {
    const f = fakeFetch([[/./, (_u, init) => {
      if (proxyOf(init)) throw new Error("connect to http://u:p@px1:1 refused");
      return answer(429)();
    }]]);
    const err = await new ProxyFallback(proxies).wrap(f.impl)("https://api.bsky.app/x").catch((e: Error) => e.message);
    expect(err).toContain("px1:1");
    expect(err).not.toContain("u:p@");
  });
});
