import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { checkReviewBodies, reviewHash, type ReviewEvidence } from "../src/ai/evidence";
import { Ai, type Provider } from "../src/ai/providers";
import { reviewRoutes } from "../src/ai/routes";
import type { Sql } from "../src/db";
import { DEFAULT_RADAR, Radar } from "../src/radar";
import { Bluesky } from "../src/sources/bluesky";
import { Wikipedia } from "../src/sources/wikipedia";
import { Store } from "../src/store";
import { EVIDENCE, REQUEST, RESPONSE } from "./fixtures/review";
import { fakeFetch, json, quietLog, testDb } from "./helpers";

/**
 * GET /v1/reviews/:hash serves a stored review with the exact bodies its signature covers, so a
 * third party can recompute the hashes in the signed text from the answer alone.
 */

let sql: Sql;
let store: Store;
beforeAll(async () => {
  sql = await testDb();
  store = new Store(sql);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE ai_reviews CASCADE`;
});

type Served = { hash: string; evidence: ReviewEvidence; request: string | null; response: string | null; createdAt: string };
const get = (hash: string) => reviewRoutes(store).request(`/reviews/${hash}`);

describe("GET /v1/reviews/:hash", () => {
  test("serves the evidence and the exact request and response, which hash into its signed text", async () => {
    const hash = await store.saveReview({ evidence: EVIDENCE, request: REQUEST, response: RESPONSE });
    expect(hash).toBe(reviewHash(EVIDENCE));
    const res = await get(hash.toUpperCase());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Served;
    expect(body).toMatchObject({ hash, evidence: EVIDENCE, request: REQUEST, response: RESPONSE });
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
    // Everything a checker needs is in the answer: the bodies hash into the signed text, and the
    // evidence hashes to the review hash the registry stores.
    expect(checkReviewBodies(body.evidence, { request: body.request!, response: body.response! }).ok).toBe(true);
    expect(reviewHash(body.evidence)).toBe(hash);
    // Saving again is a no-op.
    expect(await store.saveReview({ evidence: EVIDENCE, request: REQUEST, response: RESPONSE })).toBe(hash);
    expect((await sql`SELECT count(*)::int AS n FROM ai_reviews`)[0]!.n).toBe(1);
  });

  test("refuses to store bodies the signed text does not cover", async () => {
    await expect(store.saveReview({ evidence: EVIDENCE, request: REQUEST, response: `${RESPONSE} ` })).rejects.toThrow(/do not hash to the signed text/);
    expect((await sql`SELECT count(*)::int AS n FROM ai_reviews`)[0]!.n).toBe(0);
  });

  test("a review stored before the bodies were kept serves them as null", async () => {
    const hash = reviewHash(EVIDENCE);
    await sql`INSERT INTO ai_reviews (review_hash, model, completion_id, evidence) VALUES (${hash}, ${EVIDENCE.model}, ${EVIDENCE.completionId}, ${sql.json(EVIDENCE as never)})`;
    expect(await (await get(hash)).json()).toMatchObject({ hash, evidence: EVIDENCE, request: null, response: null });
    // A review has both bodies or neither. (A postgres.js query runs when `then` is called, so it is awaited, not handed to expect.)
    const refused = await sql`UPDATE ai_reviews SET request_body = ${REQUEST} WHERE review_hash = ${hash}`.then(
      () => null,
      (e: Error) => e.message,
    );
    expect(refused).toMatch(/ai_reviews_bodies_check/);
  });

  test("answers 400 for a malformed hash and 404 for an unknown one", async () => {
    const bad = await get("not-a-hash");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad review hash" });
    const missing = await get("0".repeat(64));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no such review" });
  });
});

describe("the radar's reviews", () => {
  test("stores the model's signed review with its bodies, and the proposal carries its hash", async () => {
    const f = fakeFetch([
      [/getTrends/, () => json({ trends: [{ topic: "w1", displayName: "World Cup final", postCount: 900, status: "trending", category: "sports" }] })],
      [/pageviews\/top/, () => json({ items: [{ articles: [] }] })],
    ]);
    const quick = { fetchImpl: f.impl, sleep: async () => {} };
    const item = { index: 0, trend_worthy: true, duplicate_of: null, asset_class: "topic", slug: "world cup final", display_name: "World Cup final", keywords: ["World Cup"], wikipedia_article: null, ticker: null, summary: "s", policy_flags: [], confidence: 0.9 };
    // A verifiable model's answer, as nearAi() returns it: the value and the signed review.
    const model: Provider = { name: "near-ai:z-ai/glm-5.3-flash", generate: async () => ({ value: { items: [item] }, review: { evidence: EVIDENCE, request: REQUEST, response: RESPONSE } }) };
    const radar = new Radar(store, null, new Wikipedia("Bot/1.0 (https://example.org)", "en.wikipedia", f.impl, { sleep: async () => {} }), new Ai([model]), { ...DEFAULT_RADAR, narrativesEvery: 1, autoApproveConfidence: 0.8 }, quietLog, {
      bluesky: new Bluesky("https://api.bsky.app", quick),
    });
    expect((await radar.tick(Date.parse("2026-10-15T12:00:00Z"))).approved).toBe(1);
    const [candidate] = await store.candidates("approved", 10);
    expect(candidate).toMatchObject({ identifier: "topic:world-cup-final", reviewHash: reviewHash(EVIDENCE) });
    expect(await (await get(candidate!.reviewHash!)).json()).toMatchObject({ evidence: EVIDENCE, request: REQUEST, response: RESPONSE });
  });
});
