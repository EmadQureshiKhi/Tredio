import { describe, expect, test } from "bun:test";
import { describeStep, HANDLE, listingSteps, loadListingConfig, publish, publishMode, TAGLINE, TAGS } from "../src/listing";

const TOKEN = `aat_${"cd".repeat(16)}`;
const AGENT = "6f1c2b9e-3c1a-4d55-9a0b-2f8f4b6f0a11";
const SECRET = "w".repeat(48);

describe("the publish guard", () => {
  test("without --publish the script only prints", () => {
    expect(publishMode([], {})).toBe("print");
    expect(publishMode(["--dry"], { AGENT_MARKET_PUBLISH: "yes" })).toBe("print");
  });

  test("--publish needs AGENT_MARKET_PUBLISH=yes, set by the owner", () => {
    expect(() => publishMode(["--publish"], {})).toThrow(/AGENT_MARKET_PUBLISH=yes/);
    expect(() => publishMode(["--publish"], { AGENT_MARKET_PUBLISH: "1" })).toThrow(/AGENT_MARKET_PUBLISH=yes/);
    expect(publishMode(["--publish"], { AGENT_MARKET_PUBLISH: "yes" })).toBe("publish");
  });
});

describe("the listing", () => {
  test("within the market's bounds: handle, tagline, tags", () => {
    expect(HANDLE.test("tredio")).toBe(true);
    expect(HANDLE.test("ab")).toBe(false);
    expect(HANDLE.test("tredio-")).toBe(false);
    expect(HANDLE.test("xn--abc")).toBe(false);
    expect(HANDLE.test("1tredio")).toBe(false);
    expect(TAGLINE.length).toBeLessThanOrEqual(200);
    expect(TAGS.length).toBeLessThanOrEqual(10);
    for (const t of TAGS) expect(t.length).toBeLessThanOrEqual(40);
  });

  test("a new agent: register, profile, plan, live, then the owner's adoption link", () => {
    const steps = listingSteps(loadListingConfig({}));
    expect(steps.map((s) => s.id)).toEqual(["register", "profile", "plans", "plan", "default-plan", "live", "adoption-code"]);
    expect(steps[0]).toMatchObject({ method: "POST", path: "/v1/agents/register", auth: "none", body: { handle: "tredio", name: "Tredio attention check", category: "data", sla_seconds: 120 } });
    expect(steps.find((s) => s.id === "plan")!.body).toMatchObject({ model: "per_call", price_amount: "0.05", sla_seconds: 120 });
    expect(steps.find((s) => s.id === "live")!.body).toEqual({ listing_status: "live" });
    const profile = steps.find((s) => s.id === "profile")!.body as { description: string; input_schema: unknown; output_schema: { required: string[] }; bio_markdown: string };
    expect(profile.description).toBe(TAGLINE);
    expect(profile.output_schema.required).toContain("onChain");
    expect(profile.bio_markdown).toContain("0.05 USDC a call");
  });

  test("an agent the owner created on the website: no registration, the webhook when the worker is public", () => {
    const c = loadListingConfig({ MARKET_API_TOKEN: TOKEN, AGENT_MARKET_AGENT_ID: AGENT, WORKER_PUBLIC_URL: "https://agents.tredio.bid/", MARKET_WEBHOOK_SECRET: SECRET, PRICE_USDC: "0.1" });
    const steps = listingSteps(c);
    expect(steps.map((s) => s.id)).toEqual(["profile", "webhook", "webhook-test", "plans", "plan", "default-plan", "live"]);
    expect(steps.find((s) => s.id === "webhook")!.body).toEqual({ webhook_url: "https://agents.tredio.bid/market/webhook", webhook_secret: SECRET });
    expect(steps.find((s) => s.id === "plan")!.body).toMatchObject({ price_amount: "0.10" });
  });

  test("settings that cannot work are refused", () => {
    expect(() => loadListingConfig({ MARKET_API_TOKEN: TOKEN })).toThrow(/AGENT_MARKET_AGENT_ID/);
    expect(() => loadListingConfig({ WORKER_PUBLIC_URL: "https://x.example" })).toThrow(/MARKET_WEBHOOK_SECRET/);
    expect(() => loadListingConfig({ WORKER_PUBLIC_URL: "http://localhost:4800", MARKET_WEBHOOK_SECRET: SECRET })).toThrow(/HTTPS/);
    expect(() => loadListingConfig({ AGENT_MARKET_HANDLE: "Tredio" })).toThrow();
  });

  test("the printed plan never shows the token or the webhook secret", () => {
    const c = loadListingConfig({ MARKET_API_TOKEN: TOKEN, AGENT_MARKET_AGENT_ID: AGENT, WORKER_PUBLIC_URL: "https://agents.tredio.bid", MARKET_WEBHOOK_SECRET: SECRET });
    const printed = listingSteps(c).map((s) => describeStep(s, c.MARKET_URL)).join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain(SECRET);
    expect(printed).toContain("Authorization: Bearer <MARKET_API_TOKEN>");
    expect(printed).toContain("<MARKET_WEBHOOK_SECRET, 48 characters>");
    expect(printed).toContain("PATCH https://market.near.ai/v1/agents/{agentId}");
  });
});

/** A fake market that records requests (the script is never run with --publish here). */
function fakeMarket(answers: Record<string, { status: number; body: unknown }>) {
  const sent: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    sent.push({ method, path: u.pathname, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers[`${method} ${u.pathname}`] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, sent };
}

describe("publishing, against a fake market", () => {
  test("registration's token and agent id carry the later steps; the token reaches only onToken", async () => {
    const newToken = `aat_${"ef".repeat(16)}`;
    const m = fakeMarket({
      "POST /v1/agents/register": { status: 201, body: { agentId: AGENT, accountId: "acc", handle: "tredio", apiToken: newToken, tokenPrefix: "aat_efef" } },
      [`GET /v1/agents/${AGENT}/pricing-plans`]: { status: 200, body: [] },
      [`POST /v1/agents/${AGENT}/pricing-plans`]: { status: 201, body: { pricing_plan_id: "plan-1" } },
      "POST /v1/agents/me/adoption-code": { status: 201, body: { code: "c", adoptionUrl: "https://market.near.ai/adopt/c", expiresAt: "2026-11-10T00:00:00Z" } },
    });
    let saved: [string, string] | null = null;
    const c = loadListingConfig({});
    const results = await publish(listingSteps(c), { marketUrl: "https://market.test", price: c.PRICE_USDC, slaSeconds: c.SLA_SECONDS, fetchImpl: m.f, onToken: (t, a) => void (saved = [t, a]) });
    expect(saved!).toEqual([newToken, AGENT]);
    expect(m.sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/agents/register",
      `PATCH /v1/agents/${AGENT}`,
      `GET /v1/agents/${AGENT}/pricing-plans`,
      `POST /v1/agents/${AGENT}/pricing-plans`,
      "POST /v1/pricing-plans/plan-1/make-default",
      `PATCH /v1/agents/${AGENT}`,
      "POST /v1/agents/me/adoption-code",
    ]);
    expect(m.sent[0]!.auth).toBeNull();
    expect(m.sent.slice(1).every((r) => r.auth === `Bearer ${newToken}`)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(newToken);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("a live default plan at the same price is kept as it is, and a refused optional webhook does not stop the publish", async () => {
    const m = fakeMarket({
      [`PATCH /v1/agents/${AGENT}`]: { status: 200, body: {} },
      [`GET /v1/agents/${AGENT}/pricing-plans`]: { status: 200, body: [{ pricing_plan_id: "p0", model: "per_call", price_amount: "0.05", is_default: true, listing_status: "live", sla_seconds: 120 }] },
      [`POST /v1/agents/${AGENT}/webhook/test`]: { status: 403, body: { error: "agent_token_scope_forbidden" } },
    });
    const c = loadListingConfig({ MARKET_API_TOKEN: TOKEN, AGENT_MARKET_AGENT_ID: AGENT, WORKER_PUBLIC_URL: "https://agents.tredio.bid", MARKET_WEBHOOK_SECRET: SECRET });
    const results = await publish(listingSteps(c), { marketUrl: "https://market.test", token: TOKEN, agentId: AGENT, price: c.PRICE_USDC, slaSeconds: c.SLA_SECONDS, fetchImpl: m.f });
    expect(results.map((r) => [r.id, r.skipped ? "skipped" : r.status])).toEqual([
      ["profile", 200],
      ["webhook", 200],
      ["webhook-test", 403],
      ["plans", 200],
      ["plan", "skipped"],
      ["default-plan", "skipped"],
      ["live", 200],
    ]);
  });

  test("a refused required step stops the publish before the listing goes live", async () => {
    const m = fakeMarket({ [`PATCH /v1/agents/${AGENT}`]: { status: 400, body: { error: "validation_error", message: "description over 200 characters" } } });
    const c = loadListingConfig({ MARKET_API_TOKEN: TOKEN, AGENT_MARKET_AGENT_ID: AGENT });
    const results = await publish(listingSteps(c), { marketUrl: "https://market.test", token: TOKEN, agentId: AGENT, price: c.PRICE_USDC, slaSeconds: c.SLA_SECONDS, fetchImpl: m.f });
    expect(results.map((r) => r.id)).toEqual(["profile"]);
    expect(m.sent.length).toBe(1);
  });
});
