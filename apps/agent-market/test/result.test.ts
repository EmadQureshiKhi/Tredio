import { describe, expect, test } from "bun:test";
import { window24h } from "../src/check";
import { INPUT_JSON_SCHEMA, outputJsonSchema, parseDeliverable, renderMarkdown, RESULT_SCHEMA_ID, resultSchema } from "../src/result";
import { checker, D, fakeApi, fakeChain, NOW_SEC, REVIEW_HASH, TREND } from "./helpers";

describe("a listed trend's attention check", () => {
  test("index, sources, registry checkpoint and the verified review, in the published shape", async () => {
    const c = checker();
    const res = (await c.resolve(["Godzilla"]))!;
    expect(res.kind).toBe("trend");
    const r = resultSchema.parse(await c.check(res));
    expect(r.schema).toBe(RESULT_SCHEMA_ID);
    expect(r.query).toBe("Godzilla");
    expect(r.network).toBe("testnet");
    expect(r.match).toEqual({ status: "listed", how: "keyword", alternatives: [], relistedFrom: null });
    expect(r.topic).toMatchObject({ identifier: TREND, name: "Godzilla Minus Zero", status: "active", page: `https://app.tredio.bid/t/${TREND}` });
    // The index is the registry's (6 decimals on chain), with the API's 24-hour series beside it.
    expect(r.index).toMatchObject({ now: 99.88, peak: 99.88, updatedAt: 1794248794, change24h: { from: 99.88, to: 99.88, pct: 0, since: 1794247547 }, checkpoints24h: 4 });
    expect(r.onChain).toMatchObject({ registry: D.contracts.registry, checkpoint: { at: 1794248794, index: 99.88, raw: 99_880_000 }, checkpoints: 4, matchesApi: true, oracleReport: null });
    expect(r.onChain!.trend).toMatchObject({ status: "active", index: 99.88, fresh: true, reviewHash: REVIEW_HASH });
    expect(r.onChain!.verify[0]).toBe(`near contract call-function as-read-only registry.tredio.testnet history json-args '{"id":"${TREND}"}' network-config testnet now`);
    // Each source with its part: Bluesky and Wikipedia counted; GDELT too old; Hacker News below the index.
    const counted = r.sources.filter((s) => s.counted);
    expect(counted.map((s) => s.source)).toEqual(["wikipedia", "bluesky"]);
    expect(counted.reduce((a, s) => a + s.points, 0)).toBeCloseTo(99.88, 1);
    expect(r.recomputed!.points).toBe(99.88);
    // The real NEAR AI Cloud evidence: hash, ed25519 signature and both bodies check out here.
    expect(r.review).toMatchObject({
      hash: REVIEW_HASH,
      url: `https://api.tredio.bid/v1/reviews/${REVIEW_HASH}`,
      onChainHashMatches: true,
      provider: "near-ai-cloud",
      signatureKind: "provider_tee",
      signingAlgo: "ed25519",
      checks: { hashMatches: true, signatureMatchesSigner: true, bodiesMatch: true },
      verified: true,
    });
    expect(r.radar).toBeNull();
    expect(r.notes).toEqual([]);
  });

  test("a tampered review is reported as not verified", async () => {
    const review = (await fakeApi().get<Record<string, unknown>>(`/v1/reviews/${REVIEW_HASH}`)) as { response: string };
    const api = fakeApi({ [`/v1/reviews/${REVIEW_HASH}`]: { ...review, response: `${review.response} ` } });
    const r = await checker({ api }).check((await checker({ api }).resolve([TREND]))!);
    expect(r.review).toMatchObject({ checks: { hashMatches: true, signatureMatchesSigner: true, bodiesMatch: false }, verified: false });
  });

  test("a retired listing whose topic listed again is answered from the new listing", async () => {
    const api = fakeApi({ [`/v1/trends/${encodeURIComponent("topic:godzilla-minus-zero")}`]: { trend: { status: "retired", identifier: "topic:godzilla-minus-zero" }, index: [], history: [], relistedAs: TREND } });
    const c = checker({ api });
    const r = await c.check((await c.resolve(["topic:godzilla-minus-zero"]))!);
    expect(r.topic.identifier).toBe(TREND);
    expect(r.match.relistedFrom).toBe("topic:godzilla-minus-zero");
    expect(r.notes[0]).toContain("listed again as topic:godzilla-minus-zero.2");
  });

  test("without RPC the answer still comes, from the API alone, and says so", async () => {
    const chain = fakeChain({ [`get_trend:${TREND}`]: new Error("rpc 429"), [`history:${TREND}`]: new Error("rpc 429") });
    const c = checker({ chain });
    const r = await c.check((await c.resolve([TREND]))!);
    expect(r.onChain).toBeNull();
    expect(r.index!.now).toBe(99.88);
    expect(r.review!.onChainHashMatches).toBeNull();
    expect(r.notes.some((n) => n.includes("could not be read over NEAR RPC"))).toBe(true);
  });

  test("a radar candidate: readings and its queue place, no index, no review", async () => {
    const c = checker();
    const r = resultSchema.parse(await c.check((await c.resolve(["Cardano"]))!));
    expect(r.match.status).toBe("candidate");
    expect(r.topic).toMatchObject({ identifier: "crypto:ada", status: "on_radar", page: "https://app.tredio.bid/radar" });
    expect(r.index).toBeNull();
    expect(r.onChain).toBeNull();
    expect(r.review).toBeNull();
    expect(r.radar).toMatchObject({ source: "coingecko_trending", attribution: { text: "Data from CoinGecko" } });
    expect(r.radar!.readings.mentions).toBeGreaterThan(0);
    expect(renderMarkdown(r)).toContain("is on Tredio's radar, waiting for a live slot");
  });

  test("the deliverable is Markdown whose JSON block parses back into the result", async () => {
    const c = checker();
    const r = await c.check((await c.resolve(["Godzilla"]))!);
    const md = renderMarkdown(r);
    expect(md).toStartWith("# Attention check: Godzilla Minus Zero\n\n**99.88 / 100** on Tredio's attention index (`topic:godzilla-minus-zero.2`, active), +0.0% since 2026-11-09 18:05 UTC, peak 99.88.");
    expect(md).toContain("| Bluesky posts | 2,901 posts in 24 h | 1 | 58.33 |");
    expect(md).toContain("evidence, signature and bodies verified");
    expect(parseDeliverable(md)).toEqual(resultSchema.parse(r));
    expect(Buffer.byteLength(md)).toBeLessThan(16 * 1024);
  });
});

describe("the 24-hour window", () => {
  test("change from 24 hours ago, the range inside the window, one value an hour carried forward", () => {
    const now = 1_000_000;
    const pts = [
      { t: now - 30 * 3600, v: 40 },
      { t: now - 25 * 3600, v: 50 },
      { t: now - 20 * 3600, v: 55 },
      { t: now - 20 * 3600 + 600, v: 57 },
      { t: now - 2 * 3600, v: 60 },
      { t: now - 60, v: 75 },
    ];
    const w = window24h(pts, now);
    expect(w.change24h).toEqual({ from: 50, to: 75, pct: 50, since: now - 25 * 3600 });
    expect(w.min24h).toBe(55);
    expect(w.max24h).toBe(75);
    expect(w.checkpoints24h).toBe(4);
    expect(w.series24h.length).toBe(24);
    expect(w.series24h[0]).toEqual({ t: now - 23 * 3600, v: 50 });
    expect(w.series24h[4]).toEqual({ t: now - 19 * 3600, v: 57 });
    expect(w.series24h.at(-1)).toEqual({ t: now, v: 75 });
  });

  test("a listing younger than a day counts from its first checkpoint; no points, no change", () => {
    const now = 2_000_000;
    expect(window24h([{ t: now - 3600, v: 10 }, { t: now - 60, v: 12 }], now).change24h).toEqual({ from: 10, to: 12, pct: 20, since: now - 3600 });
    expect(window24h([], now)).toEqual({ change24h: null, min24h: null, max24h: null, checkpoints24h: 0, series24h: [] });
  });
});

describe("the listing's schemas", () => {
  test("the output schema is the result's JSON Schema; the input schema takes a topic", () => {
    const s = outputJsonSchema() as { type: string; required: string[]; properties: Record<string, unknown> };
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["schema", "query", "answeredAt", "network", "match", "topic", "index", "sources", "recomputed", "onChain", "review", "radar", "notes"]);
    expect(INPUT_JSON_SCHEMA.required).toEqual(["topic"]);
  });

  test("answeredAt is the checker's clock", async () => {
    const c = checker({ nowSec: NOW_SEC + 5 });
    expect((await c.check((await c.resolve([TREND]))!)).answeredAt).toBe(NOW_SEC + 5);
  });
});
