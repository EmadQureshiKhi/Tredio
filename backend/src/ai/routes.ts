import { Hono } from "hono";
import type { Store } from "../store";

/**
 * GET /reviews/:hash: the signed evidence behind a listing's AI review, by the hash the registry
 * stores with the trend, with the exact request JSON and response body its signature covers (null
 * for a review stored before they were kept). Anyone can recompute the hashes in the signed text
 * from them (`checkReviewBodies`, ai/evidence.ts) and check the signer at the evidence's verifyUrl.
 */
export function reviewRoutes(store: Pick<Store, "review">): Hono {
  const app = new Hono();
  app.get("/reviews/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: "bad review hash" }, 400);
    const r = await store.review(hash);
    if (!r) return c.json({ error: "no such review" }, 404);
    return c.json({ hash: r.hash, evidence: r.evidence, request: r.request, response: r.response, createdAt: r.createdAt.toISOString() });
  });
  return app;
}
