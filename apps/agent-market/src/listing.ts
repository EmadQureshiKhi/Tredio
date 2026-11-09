import { z } from "zod";
import { AGENT_TOKEN, formatUsdc, microUsdc, usdcAmount } from "./config";
import { INPUT_JSON_SCHEMA, outputJsonSchema } from "./result";

/**
 * The agent's listing on the NEAR AI Agent Market, and the requests that publish it, in order
 * (`/skill/flows/a2a-x402.md`, `/openapi.json` tag `agents`):
 *
 * 1. `POST /v1/agents/register` when no agent exists yet (its token is shown once; the owner
 *    adopts the agent afterwards with the adoption link, since a self-registered agent cannot
 *    withdraw); skipped when the owner created the agent on the website and minted its token.
 * 2. `PATCH /v1/agents/{agentId}`: name, tagline, category, tags, the long description, the input
 *    and output JSON Schemas, the delivery window.
 * 3. The webhook (`webhook_url`, `webhook_secret`) and its test ping, when the worker has a public
 *    URL. The webhook reference says only the owner may set it; when the token is refused, the
 *    owner sets it on the website and the worker polls meanwhile.
 * 4. A `per_call` pricing plan at the agent's price, made the default (the 402 quotes it).
 * 5. `PATCH /v1/agents/{agentId}` with `listing_status: "live"`.
 * 6. For a self-registered agent: `POST /v1/agents/me/adoption-code`, the owner's link to adopt it.
 */

export const CATEGORIES = ["automation", "creative", "customer_support", "data", "dev_tools", "events", "finance", "legal_compliance", "marketing", "operations", "research", "sales", "travel", "other"] as const;

/** Handles become DNS labels: 3 to 30 characters, a lowercase letter first, no trailing `-`, no `--` at positions 3 and 4. */
export const HANDLE = /^(?!.{2}--)[a-z][a-z0-9-]{1,28}[a-z0-9]$/;

const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  MARKET_URL: z.string().url().transform((u) => u.replace(/\/+$/, "")).default("https://market.near.ai"),
  AGENT_MARKET_HANDLE: z.string().regex(HANDLE, "a handle is 3 to 30 lowercase letters, digits and -, starting with a letter").default("tredio-attention"),
  AGENT_MARKET_NAME: z.string().trim().min(1).max(80).default("Tredio attention check"),
  AGENT_MARKET_CATEGORY: z.enum(CATEGORIES).default("data"),
  /** Optional contact for a self-registered agent. */
  AGENT_MARKET_EMAIL: optional(z.string().email()),
  PRICE_USDC: usdcAmount.default("0.05"),
  /** The window a call commits to: the A2A payment stays valid for it plus 10 minutes. */
  SLA_SECONDS: z.coerce.number().int().min(30).max(2_592_000).default(120),
  /** The worker's public HTTPS origin, for the webhook (the market refuses loopback and private addresses). */
  WORKER_PUBLIC_URL: optional(z.string().url().refine((u) => u.startsWith("https://"), "the market delivers webhooks to public HTTPS URLs only").transform((u) => u.replace(/\/+$/, ""))),
  MARKET_WEBHOOK_SECRET: optional(z.string().min(32)),
  /** An existing agent: its token and id (from the website, or a previous self-registration). */
  MARKET_API_TOKEN: optional(z.string().regex(AGENT_TOKEN)),
  AGENT_MARKET_AGENT_ID: optional(z.string().uuid()),
});

export type ListingConfig = z.infer<typeof schema>;

export function loadListingConfig(env: Record<string, string | undefined>): ListingConfig {
  const c = schema.parse(env);
  if (Boolean(c.MARKET_API_TOKEN) !== Boolean(c.AGENT_MARKET_AGENT_ID)) throw new Error("set both MARKET_API_TOKEN and AGENT_MARKET_AGENT_ID (an existing agent), or neither (register a new one)");
  if (c.WORKER_PUBLIC_URL && !c.MARKET_WEBHOOK_SECRET) throw new Error("WORKER_PUBLIC_URL needs MARKET_WEBHOOK_SECRET (the same secret the worker checks)");
  return c;
}

/** The listing's tagline: at most 200 characters. */
export const TAGLINE = "Attention index (0 to 100) for any topic from Tredio's oracle on NEAR: the value now and over 24 h, each source's share, the registry checkpoint and the NEAR AI review.";
export const TAGS = ["attention", "trends", "index", "near", "oracle", "verifiable", "social-signals", "near-ai", "x402", "tredio"];

export function bioMarkdown(price: string): string {
  return [
    "Send a topic in words (World Cup, $TSLA, Godzilla Minus Zero) or as a Tredio identifier (topic:world-cup); the first line of the message is enough.",
    "",
    "You get back Markdown with a short summary and a JSON block (the output schema), which holds:",
    "",
    "- the attention index now (0 to 100), its peak, its change and range over 24 hours, and one value an hour;",
    "- each source behind it (X and Telegram through Elfa, GDELT news, Bluesky, Wikipedia, Hacker News, Nansen for crypto): the raw reading, its normalized component, its weight and the points it contributes, recomputed with the oracle's published method;",
    "- the registry contract's newest checkpoint, read over NEAR RPC, with the oracle report that wrote it and that report's signature check;",
    "- the NEAR AI Cloud review behind the listing: model, TEE signature, signer, and checks of the evidence hash, the signature and the signed request and response;",
    "- the commands and links to verify each of these yourself.",
    "",
    "A topic Tredio does not list but has on its radar comes back with its radar readings and place in the queue. A topic Tredio does not track at all is declined, and you are not charged.",
    "",
    `Price: ${price} USDC a call. Tredio's contracts run on NEAR testnet today, so the index and checkpoints are testnet data.`,
    "",
    "Tredio: https://tredio.bid",
  ].join("\n");
}

export interface Step {
  id: "register" | "profile" | "webhook" | "webhook-test" | "plans" | "plan" | "default-plan" | "live" | "adoption-code";
  method: "GET" | "POST" | "PATCH";
  /** May hold `{agentId}` and `{planId}`, filled in from earlier answers. */
  path: string;
  body?: unknown;
  /** `none` for registration; `agent` sends the agent's token. */
  auth: "none" | "agent";
  /** A refusal of an optional step is reported and the publish goes on. */
  optional?: boolean;
  note?: string;
}

export function listingSteps(c: ListingConfig): Step[] {
  const price = formatUsdc(microUsdc(c.PRICE_USDC));
  const steps: Step[] = [];
  const registering = !c.MARKET_API_TOKEN;
  if (registering) {
    steps.push({
      id: "register",
      method: "POST",
      path: "/v1/agents/register",
      body: { handle: c.AGENT_MARKET_HANDLE, name: c.AGENT_MARKET_NAME, category: c.AGENT_MARKET_CATEGORY, ...(c.AGENT_MARKET_EMAIL ? { email: c.AGENT_MARKET_EMAIL } : {}), sla_seconds: c.SLA_SECONDS },
      auth: "none",
      note: "answers apiToken once: it is written to apps/agent-market/.env (MARKET_API_TOKEN, AGENT_MARKET_AGENT_ID), never printed",
    });
  }
  steps.push({
    id: "profile",
    method: "PATCH",
    path: "/v1/agents/{agentId}",
    body: { name: c.AGENT_MARKET_NAME, description: TAGLINE, category: c.AGENT_MARKET_CATEGORY, tags: TAGS, bio_markdown: bioMarkdown(price), input_schema: INPUT_JSON_SCHEMA, output_schema: outputJsonSchema(), sla_seconds: c.SLA_SECONDS },
    auth: "agent",
  });
  if (c.WORKER_PUBLIC_URL && c.MARKET_WEBHOOK_SECRET) {
    steps.push({
      id: "webhook",
      method: "PATCH",
      path: "/v1/agents/{agentId}",
      body: { webhook_url: `${c.WORKER_PUBLIC_URL}/market/webhook`, webhook_secret: c.MARKET_WEBHOOK_SECRET },
      auth: "agent",
      optional: true,
      note: "the webhook reference says an aat_ token gets 403 here; then the owner sets it on the agent's page",
    });
    steps.push({ id: "webhook-test", method: "POST", path: "/v1/agents/{agentId}/webhook/test", auth: "agent", optional: true, note: "a signed webhook.ping to the worker" });
  }
  steps.push({ id: "plans", method: "GET", path: "/v1/agents/{agentId}/pricing-plans", auth: "agent", note: "a live per_call plan at this price and window already exists: no second plan, and no default switch when it is the default" });
  steps.push({
    id: "plan",
    method: "POST",
    path: "/v1/agents/{agentId}/pricing-plans",
    body: { model: "per_call", price_amount: price, sla_seconds: c.SLA_SECONDS, display_name: "Per call", description: "One attention check: index, sources, on-chain checkpoint and review evidence for one topic." },
    auth: "agent",
  });
  steps.push({ id: "default-plan", method: "POST", path: "/v1/pricing-plans/{planId}/make-default", auth: "agent" });
  steps.push({ id: "live", method: "PATCH", path: "/v1/agents/{agentId}", body: { listing_status: "live" }, auth: "agent", note: "start the worker first: the market reads a silent agent as unreachable" });
  if (registering) steps.push({ id: "adoption-code", method: "POST", path: "/v1/agents/me/adoption-code", auth: "agent", note: "the owner opens adoptionUrl to adopt the agent and its balance (a self-registered agent cannot withdraw)" });
  return steps;
}

/** What a step sends, as printed: the token and the webhook secret never appear. */
export function describeStep(s: Step, marketUrl: string): string {
  const body = s.body === undefined ? "" : `\n${JSON.stringify(s.body, (k, v) => (k === "webhook_secret" ? `<MARKET_WEBHOOK_SECRET, ${String(v).length} characters>` : v), 2)}`;
  const auth = s.auth === "agent" ? "\nAuthorization: Bearer <MARKET_API_TOKEN>" : "";
  return `${s.method} ${marketUrl}${s.path}${auth}${s.optional ? "\n(optional: a refusal is reported, the publish goes on)" : ""}${s.note ? `\n# ${s.note}` : ""}${body}`;
}

/** `--publish` runs only when the owner set AGENT_MARKET_PUBLISH=yes; anything else prints the plan. */
export function publishMode(argv: readonly string[], env: Record<string, string | undefined>): "print" | "publish" {
  if (!argv.includes("--publish")) return "print";
  if (env.AGENT_MARKET_PUBLISH !== "yes") throw new Error("--publish lists the agent on the live market: it runs only with AGENT_MARKET_PUBLISH=yes, set by the agent's owner");
  return "publish";
}

export interface StepResult {
  id: Step["id"];
  status: number;
  ok: boolean;
  skipped?: boolean;
  body: unknown;
}

/**
 * Sends the steps in order, filling `{agentId}` and `{planId}` from earlier answers; a refused
 * step that is not optional stops the run. `onToken` receives a new registration's token, the
 * one time the market shows it.
 */
export async function publish(
  steps: readonly Step[],
  o: { marketUrl: string; token?: string; agentId?: string; price: string; slaSeconds: number; fetchImpl?: typeof fetch; onToken?: (token: string, agentId: string) => void | Promise<void> },
): Promise<StepResult[]> {
  const f = o.fetchImpl ?? fetch;
  let token = o.token;
  const vars: Record<string, string | undefined> = { agentId: o.agentId, planId: undefined };
  const results: StepResult[] = [];
  const skip = new Set<Step["id"]>();
  for (const s of steps) {
    if (skip.has(s.id)) {
      results.push({ id: s.id, status: 0, ok: true, skipped: true, body: null });
      continue;
    }
    const path = s.path.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = vars[k];
      if (!v) throw new Error(`step ${s.id} needs {${k}}, which no earlier answer gave`);
      return encodeURIComponent(v);
    });
    if (s.auth === "agent" && !token) throw new Error(`step ${s.id} needs the agent's token`);
    const res = await f(`${o.marketUrl}${path}`, {
      method: s.method,
      headers: { accept: "application/json", ...(s.body === undefined ? {} : { "content-type": "application/json" }), ...(s.auth === "agent" ? { authorization: `Bearer ${token}` } : {}) },
      body: s.body === undefined ? undefined : JSON.stringify(s.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Keep the text.
    }
    if (s.id === "register" && res.ok) {
      const r = body as { apiToken: string; agentId: string };
      token = r.apiToken;
      vars.agentId = r.agentId;
      await o.onToken?.(r.apiToken, r.agentId);
      body = { ...(body as object), apiToken: `${r.apiToken.slice(0, 8)}...` };
    }
    if (s.id === "plans" && res.ok && Array.isArray(body)) {
      const want = microUsdc(o.price);
      const plans = body as Array<{ pricing_plan_id: string; model: string; price_amount: string; is_default: boolean; listing_status: string; sla_seconds: number | null }>;
      const same = plans.find((p) => p.model === "per_call" && p.listing_status === "live" && microUsdc(p.price_amount) === want && (p.sla_seconds ?? null) === o.slaSeconds);
      // The plan already exists: no second one (an agent holds at most five); make it the default unless it is.
      if (same) {
        skip.add("plan");
        if (same.is_default) skip.add("default-plan");
        vars.planId = same.pricing_plan_id;
      }
    }
    if (s.id === "plan" && res.ok) {
      vars.planId = (body as { pricing_plan_id?: string }).pricing_plan_id;
      if (!vars.planId) throw new Error("the plan step answered no pricing_plan_id");
    }
    results.push({ id: s.id, status: res.status, ok: res.ok, body });
    if (!res.ok && !s.optional) break;
  }
  return results;
}
