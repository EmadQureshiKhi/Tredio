import type { HyperliquidInfo } from "@tredio/hyperliquid";
import type { OneClick } from "@tredio/intents";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { assess } from "../ai/assess";
import { autopilotAdminRoutes, autopilotRoutes } from "../autopilot/routes";
import type { AutopilotService } from "../autopilot/service";
import type { AutopilotStore } from "../autopilot/store";
import type { Ai } from "../ai/providers";
import type { KeyRing } from "../budget";
import type { ChainReader, ChainTrend } from "../chain";
import type { Collector } from "../collector";
import type { IndexHistory } from "../history";
import { isPushEndpoint, type Push, TOPICS, type Topic } from "../notify/push";
import { moderationRoutes } from "../social/moderation";
import { socialRoutes } from "../social/routes";
import { parseServices, serviceDetails, status } from "../status";
import { AccountKeys, SIGNER_CHECK_TTL_MS, type SessionReader, userAuth } from "./user-auth";
import { type OwnerKeyReader, ownerApprovalRoutes, OwnerApprovals } from "./owner-approval";
import type { AccessKeyReader } from "./near-auth";
import type { Config } from "../config";
import { ASSET_CLASSES, assetClassOf, baseOf, isNormalized, tickerOf } from "../identifiers";
import { LinkError, resolveLink } from "../links";
import type { Log } from "../log";
import { type Radar, SOURCE_ATTRIBUTION } from "../radar";
import { communityPicks, mentionsOf, type QueueOptions, rankQueue } from "../queue";
import { readingsOf, signalOf, SPARK_HOURS, SPARK_SOURCES, sparkOf } from "../radar-view";
import type { Jobs } from "../jobs";
import type { Gdelt } from "../sources/gdelt";
import type { Fetch } from "../sources/http";
import { type Candidate, type CandidateStatus, type Reading, type Rotation, SOURCES, type SourceName, type Store, type TrendMeta } from "../store";
import { ADMIN_SESSION_SEC, adminAuth, bearer, issueSession, tokenExpiry, tokenHash } from "./admin-auth";
import { byIp, rateLimit } from "./rate-limit";
import type { IndexerReader } from "../indexer";
import { depositRoutes } from "../deposits/routes";
import { type ActivationTickets, activationTicketRoutes } from "../activation/tickets";
import { waitlistAdminRoutes, waitlistRoutes } from "../waitlist/routes";
import type { KeyCheck } from "../sources/elfa";
import type { SystemMonitor } from "../system";
import { type Alert, type Alerts, MAX_ALERTS } from "../alerts";

/** Topics one account can wait on at once (each wait also counts toward community picks). */
const MAX_WATCHES = 25;

/** On-chain reads behind sign-in and approvals: access keys, account sessions and passkey keys. */
export interface NearReads {
  accessKey: AccessKeyReader;
  session: SessionReader;
  ownerKey: OwnerKeyReader;
}

export interface AppDeps {
  cfg: Config;
  store: Store;
  chain: ChainReader;
  nearReads: NearReads;
  collector: Collector;
  radar: Radar;
  ai: Ai;
  gdelt: Gdelt;
  /** Keyless sources whose rate-limit state health reports. */
  feeds?: {
    bluesky?: { available: boolean } | null;
    hn?: { available: boolean } | null;
    coingecko?: { http: { available: boolean } } | null;
    geckoterminal?: { http: { available: boolean } } | null;
    /** Fallback traffic this month against its cap. */
    proxyFallback?: { stats: { month: string; bytes: number; capBytes: number; requests: number } } | null;
  };
  /** API budgets; `ai` is the daily allowance of AI provider requests the radar and links share. */
  rings: { elfa: KeyRing | null; nansen: KeyRing | null; ai?: KeyRing | null };
  jobs: Jobs;
  /** HMAC key for admin session tokens. */
  adminSessionSecret: string;
  history: IndexHistory;
  autopilot: { store: AutopilotStore; service: AutopilotService };
  hyperliquid: HyperliquidInfo;
  /** NEAR Intents 1Click, for any-chain deposits and withdrawals. */
  oneClick: OneClick;
  push: Push;
  /** Signs the relayer's activation tickets; null when no ticket key is configured. */
  tickets?: ActivationTickets | null;
  /** Tredio's own indexer (apps/indexer); null when it is not configured. */
  indexer?: IndexerReader | null;
  /** Attention alerts (alerts.ts); absent, the routes answer 503. */
  alerts?: Alerts | null;
  /** The admin system view (GET /v1/admin/system); null turns it off. */
  system?: SystemMonitor | null;
  /** Asks Elfa for every key's status (one credit per key), for the system view's "check keys" action. */
  elfaCheck?: ((onResult?: (done: readonly KeyCheck[]) => void) => Promise<KeyCheck[]>) | null;
  log: Log;
  fetchImpl?: Fetch;
  now?: () => number;
}

const readings = (r: Partial<Record<SourceName, Reading>> | undefined) =>
  Object.fromEntries(SOURCES.map((s) => [s, r?.[s] ? { value: r[s]!.value, windowSec: r[s]!.windowSec, observedAt: r[s]!.observedAt } : null]));

function trendJson(t: ChainTrend, meta: TrendMeta | undefined, latest: Partial<Record<SourceName, Reading>> | undefined) {
  return {
    id: t.id,
    identifier: t.identifier,
    displayName: meta?.displayName ?? null,
    summary: meta?.summary ?? null,
    assetClass: ASSET_CLASSES[t.assetClass] ?? "topic",
    status: t.status.toLowerCase(),
    index: t.index,
    peakIndex: t.peakIndex,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    surfacer: t.surfacer,
    /** SHA-256 of the NEAR AI Cloud review evidence (GET /v1/reviews/<hash>), when a verifiable model reviewed it. */
    reviewHash: t.reviewHash,
    /** The Hyperliquid perp of the trend's asset, if any. */
    asset: t.asset,
    keywords: meta?.keywords ?? [],
    article: meta?.article ?? null,
    ticker: meta?.ticker ?? null,
    readings: readings(latest),
  };
}

function candidateJson(c: Candidate, full: boolean) {
  return {
    id: c.id,
    identifier: c.identifier,
    displayName: c.displayName,
    summary: c.summary,
    assetClass: ASSET_CLASSES[c.assetClass] ?? "topic",
    keywords: c.keywords,
    article: c.article,
    ticker: c.ticker,
    source: c.source,
    /** Credit the source's terms require next to its data (CoinGecko, GeckoTerminal), else null. */
    attribution: SOURCE_ATTRIBUTION[c.source] ?? null,
    surfacer: c.surfacer,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    ...(full ? { confidence: c.confidence, ai: c.ai, sourceRef: c.sourceRef, decidedBy: c.decidedBy, updatedAt: c.updatedAt.toISOString() } : {}),
  };
}

const decisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  identifier: z.string().refine(isNormalized, "identifiers use a-z, 0-9 and :._- only").optional(),
  displayName: z.string().min(1).max(40).optional(),
  keywords: z.array(z.string().min(1).max(60)).min(1).max(5).optional(),
  article: z.string().max(200).nullable().optional(),
  summary: z.string().max(140).optional(),
});

const linkBody = z.object({
  url: z.string().min(8).max(2048),
  /** Optional: the signed-in account is the surfacer, and a different one is refused. */
  surfacer: z.string().regex(/^[a-z0-9._-]{2,64}$/, "surfacer must be a NEAR account").optional(),
});

/** The "check keys" action spends a credit per key, so it runs at most this often. */
export const ELFA_CHECK_INTERVAL_MS = 60_000;

/** The largest request body: the vault's biggest item (64 KiB of ciphertext) plus its JSON. */
export const MAX_BODY_BYTES = 72 * 1024;
/** Pasted links stop once this share of the day's AI budget is spent, keeping the rest for the radar. */
export const LINK_AI_SHARE = 0.5;
export const LINKS_PER_ACCOUNT_PER_DAY = 20;
/**
 * Sign-ins per client IP per SIGN_IN_WINDOW_MS. Checking a sign-in costs database and chain reads
 * (a session key's permissions, an admin wallet's signature), so an anonymous caller cannot make
 * them unbounded; a real user signs in a few times a day.
 */
export const SIGN_INS_PER_WINDOW = 60;
export const SIGN_IN_WINDOW_MS = 600_000;

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  const now = d.now ?? Date.now;
  const ipLimit = byIp(d.cfg.TRUSTED_PROXY_HOPS);
  // Who may act for an account: a full-access key, or its trading session key while active on chain.
  const keys = new AccountKeys(d.nearReads.accessKey, d.nearReads.session, (a, k) => d.autopilot.store.isGrantKey(a, k), SIGNER_CHECK_TTL_MS, now);
  const signedIn = userAuth(d.adminSessionSecret, (h) => d.store.isRevoked(h), keys, now);
  // Follows, enabling rules and identity links also need the passkey's approval, not only a session.
  const approvals = new OwnerApprovals(d.store.sql, d.nearReads.ownerKey, d.cfg.NEAR_NETWORK, now);

  // The app and admin origins reach every route; the website reaches only the waitlist form. Pages
  // read Retry-After to say when a refused request may try again, and admin downloads keep their names.
  const corsOrigin = (origin: string, c: Context) => (d.cfg.frontendOrigins.includes(origin) || (c.req.path === "/v1/waitlist" && d.cfg.landingOrigins.includes(origin)) ? origin : null);
  app.use("*", cors({ origin: corsOrigin, allowHeaders: ["content-type", "authorization", "x-tredio-account", "x-tredio-public-key", "x-tredio-timestamp", "x-tredio-nonce", "x-tredio-signature", "x-payment"], exposeHeaders: ["retry-after", "content-disposition"], maxAge: 600 }));
  if (d.cfg.TRUSTED_PROXY_HOPS === 0) {
    // Behind a proxy with 0 hops, every caller shares the proxy's address and its per-IP limits.
    let warned = false;
    app.use("*", async (c, next) => {
      if (!warned && c.req.header("x-forwarded-for")) {
        warned = true;
        d.log.warn({}, "requests carry X-Forwarded-For but TRUSTED_PROXY_HOPS is 0: if a proxy is in front, every caller shares its address limits; set TRUSTED_PROXY_HOPS to the number of proxies (Caddy in front: 1)");
      }
      await next();
    });
  }
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  app.onError((e, c) => {
    d.log.error({ err: e.message, path: c.req.path }, "request failed");
    return c.json({ error: "internal error" }, 500);
  });

  /** The full system picture for operators: budgets, AI providers, RPC health, job outcomes. */
  const healthDetail = async (): Promise<{ ok: boolean } & Record<string, unknown>> => {
    const checks: Record<string, unknown> = {};
    let ok = true;
    try {
      await d.store.sql`SELECT 1`;
      checks.db = "ok";
    } catch (e) {
      ok = false;
      checks.db = e instanceof Error ? e.message : "down";
    }
    try {
      const trends = await d.chain.trends();
      checks.chain = {
        network: d.cfg.NEAR_NETWORK,
        trends: trends.length,
        live: trends.filter((t) => t.status === "Active" || t.status === "Cooling").length,
        lastRunId: Number(await d.chain.lastRunId()),
      };
    } catch (e) {
      ok = false;
      checks.chain = e instanceof Error ? e.message.slice(0, 200) : "down";
    }
    const budget = async (ring: KeyRing | null) => (ring ? { keys: ring.size, leftToday: await ring.leftToday() } : null);
    checks.budgets = { elfa: await budget(d.rings.elfa), nansen: await budget(d.rings.nansen), ai: await budget(d.rings.ai ?? null) };
    checks.ai = d.ai.providers.map((p) => p.name);
    checks.gdelt = d.gdelt.available ? "ok" : "resting";
    const state = (available: boolean | undefined) => (available === undefined ? null : available ? "ok" : "resting");
    checks.feeds = {
      bluesky: state(d.feeds?.bluesky?.available),
      hn: state(d.feeds?.hn?.available),
      coingecko: state(d.feeds?.coingecko?.http.available),
      geckoterminal: state(d.feeds?.geckoterminal?.http.available),
      proxyFallback: d.feeds?.proxyFallback?.stats ?? null,
    };
    checks.jobs = ok ? await d.store.jobs() : [];
    return { ok, ...checks };
  };

  // Liveness for the platform's deploy check: the process serves (migrations ran before it
  // listens), without depending on the chain RPC.
  app.get("/live", (c) => c.json({ live: true }));

  // The bare origin names the service and where to look, instead of a 404 for anyone who opens it.
  app.get("/", (c) => c.json({ service: "Tredio API", network: d.cfg.NEAR_NETWORK, live: true, health: "/health", status: "/v1/status", trends: "/v1/trends", app: "https://app.tredio.bid", docs: "https://tredio.bid/llms.txt" }));

  // Public: up or down, and how fresh the oracle is. The detail is behind admin sign-in.
  app.get("/health", async (c) => {
    const h = await healthDetail();
    const chain = h.chain as { network?: string; live?: number; lastRunId?: number } | string;
    return c.json(
      { ok: h.ok, db: h.db === "ok" ? "ok" : "down", chain: typeof chain === "string" ? "down" : { network: chain.network, live: chain.live, lastRunId: chain.lastRunId } },
      h.ok ? 200 : 503,
    );
  });

  // App reads.
  app.get("/v1/trends", async (c) => {
    const all = c.req.query("all") === "1";
    const [trends, meta, rotation] = await Promise.all([d.chain.trends(), d.store.trendMeta(), d.store.activeRotation().catch(() => null)]);
    const shown = trends.filter((t) => all || t.status === "Active" || t.status === "Cooling");
    const [latest, summaries] = await Promise.all([d.store.latest(shown.map((t) => baseOf(t.identifier))), d.history.summaries(shown.map((t) => t.id), Math.floor(now() / 1000))]);
    return c.json({
      lastRunId: Number(await d.chain.lastRunId()),
      trends: shown.map((t) => {
        const s = summaries.get(t.id);
        return {
          ...trendJson(t, meta.get(t.identifier) ?? meta.get(baseOf(t.identifier)), latest.get(baseOf(t.identifier))),
          change24h: s?.change ?? null,
          spark: s?.spark ?? [],
          rotatingOut: rotation?.identifier === t.identifier,
        };
      }),
    });
  });

  app.get("/v1/trends/:identifier", async (c) => {
    const id = c.req.param("identifier").toLowerCase();
    const all = await d.chain.trends();
    const trend = all.find((t) => t.identifier === id);
    if (!trend) return c.json({ error: "no such trend" }, 404);
    const meta = await d.store.trendMeta();
    const base = baseOf(id);
    const since = Math.floor(now() / 1000) - 7 * 86_400;
    const [latest, history, index] = await Promise.all([d.store.latest([base]), d.store.history(base, since), d.history.points(trend.id, since)]);
    // A retired listing whose topic listed again (base.2 to base.9) points to the newest live one.
    const relisted =
      trend.status === "Retired"
        ? all.filter((t) => t.identifier !== id && baseOf(t.identifier) === base && t.status !== "Retired").sort((a, b) => b.createdAt - a.createdAt)[0]
        : undefined;
    const rotation = await d.store.activeRotation().catch(() => null);
    return c.json({
      trend: { ...trendJson(trend, meta.get(id) ?? meta.get(base), latest.get(base)), rotatingOut: rotation?.identifier === trend.identifier },
      index,
      history,
      relistedAs: relisted?.identifier ?? null,
    });
  });

  // History from Tredio's indexer: track records, trade history, the trader leaderboard and trend stats.
  const isAccount = (a: string) => /^[a-z0-9._-]{2,64}$/.test(a);
  const fromIndexer = async (c: Context, read: (ix: IndexerReader) => Promise<unknown>) => {
    if (!d.indexer) return c.json({ error: "trade history is not available" }, 503);
    return c.json(await read(d.indexer));
  };
  app.get("/v1/accounts/:address", async (c) => {
    const address = c.req.param("address");
    if (!isAccount(address)) return c.json({ error: "bad account" }, 400);
    if (!d.indexer) return c.json({ error: "trade history is not available" }, 503);
    const account = await d.indexer.account(address);
    // ?optional=1: an account with no activity yet is an answer, not an error (the app asks this way).
    if (!account) return c.req.query("optional") === "1" ? c.json({ account: null }) : c.json({ error: "no activity yet" }, 404);
    return c.json({ account });
  });
  app.get("/v1/accounts/:address/activity", async (c) => {
    const address = c.req.param("address");
    if (!isAccount(address)) return c.json({ error: "bad account" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return fromIndexer(c, async (ix) => ({ items: await ix.activity(address, limit) }));
  });
  // Series the account holds outcome tokens of, old ones included; the app reads live balances on chain.
  app.get("/v1/accounts/:address/outcomes", async (c) => {
    const address = c.req.param("address");
    if (!isAccount(address)) return c.json({ error: "bad account" }, 400);
    return fromIndexer(c, async (ix) => ({ holdings: await ix.outcomeHoldings(address) }));
  });
  // Resting book orders of the account (the book has no per-owner view, so the indexer keeps them).
  app.get("/v1/accounts/:address/orders", async (c) => {
    const address = c.req.param("address");
    if (!isAccount(address)) return c.json({ error: "bad account" }, 400);
    return fromIndexer(c, async (ix) => ({ orders: await ix.openOrders(address) }));
  });
  app.get("/v1/leaderboard/traders", (c) => fromIndexer(c, async (ix) => ({ traders: await ix.traders(50) })));
  app.get("/v1/trends/:identifier/stats", async (c) => {
    if (!d.indexer) return c.json({ error: "trade history is not available" }, 503);
    // A new listing has no trades yet: an empty answer, not an error (the app hides the strip).
    const stats = await d.indexer.trend(c.req.param("identifier"), Math.floor(now() / 1000));
    return c.json({ stats: stats ?? null });
  });

  // The queue with community picks: rank once to see who is ready, pick the most-awaited of those
  // (kept topics already go first), then rank again with the picks ahead of the rest.
  const rankWithPicks = (rows: Candidate[], latest: ReadonlyMap<string, Partial<Record<SourceName, Reading>>>, opts: QueueOptions, watchers: ReadonlyMap<number, number>) => {
    const ready = rankQueue(rows, latest, opts);
    const picks = communityPicks(
      ready.filter((r) => !opts.pinned?.has(r.identifier)),
      watchers,
      { minWatchers: d.cfg.PICK_MIN_WATCHERS, max: d.cfg.PICK_MAX },
    );
    return { queue: picks.size > 0 ? rankQueue(rows, latest, { ...opts, picks }) : ready, picks };
  };

  // "On the radar": approved candidates waiting for a live slot, with the attention measured so far,
  // a sparkline, the workflow's queue order and how many accounts wait on each. Cached briefly.
  let radarCache: { at: number; body: unknown } | null = null;
  app.get("/v1/candidates", async (c) => {
    if (!radarCache || now() - radarCache.at > 30_000) {
      const nowSec = Math.floor(now() / 1000);
      const rows = await d.store.candidates("approved", 200);
      const ids = rows.map((r) => r.identifier);
      const [latest, history, watchers, trends] = await Promise.all([
        d.store.latest(ids),
        d.store.historyMany(ids, SPARK_SOURCES, nowSec - SPARK_HOURS * 3600),
        d.store.watchCounts(rows.map((r) => r.id)),
        d.chain.trends().catch(() => []),
      ]);
      const tradable = new Set((await d.autopilot.service.markets().catch(() => [])).map((m) => m.symbol.toUpperCase()));
      const { queue, picks } = rankWithPicks(rows, latest, { nowSec, confirmNetflowUsd: d.cfg.CRYPTO_CONFIRM_NETFLOW_USD, tradable, pinned: await d.store.pins() }, watchers);
      const position = new Map(queue.map((q, i) => [q.id, i + 1]));
      // A trend rotating out still holds its slot until it retires; its successor already has one.
      const outgoing = (await d.store.activeRotation())?.identifier;
      const live = trends.filter((t) => (t.status === "Active" || t.status === "Cooling") && t.identifier !== outgoing).length;
      radarCache = {
        at: now(),
        body: {
          slots: { live, max: d.cfg.MAX_LIVE_TRENDS },
          candidates: rows.map((r) => ({
            ...candidateJson(r, false),
            queue: position.get(r.id) ?? null,
            signal: signalOf(r),
            readings: readingsOf(latest.get(r.identifier), nowSec),
            ...sparkOf(history.get(r.identifier) ?? [], nowSec),
            watchers: watchers.get(r.id) ?? 0,
            pick: picks.has(r.identifier),
          })),
        },
      };
    }
    return c.json(radarCache.body);
  });
  app.get("/v1/candidates/watching", signedIn, async (c) => c.json({ ids: [...(await d.store.watching(c.get("user")))] }));
  app.post("/v1/candidates/:id/watch", rateLimit(120, 3_600_000, ipLimit, now), signedIn, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    // Watching is also a vote for community picks, so one account waits on a limited number at once.
    const already = await d.store.watching(c.get("user"));
    if (!already.has(id) && already.size >= MAX_WATCHES) return c.json({ error: `you can wait on up to ${MAX_WATCHES} topics at once` }, 409);
    if (!(await d.store.watch(id, c.get("user")))) return c.json({ error: "only candidates waiting to list can be watched" }, 404);
    radarCache = null;
    return c.json({ watching: true });
  });
  app.delete("/v1/candidates/:id/watch", signedIn, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    await d.store.unwatch(id, c.get("user"));
    radarCache = null;
    return c.json({ watching: false });
  });
  // The trend being rotated out (its index goes stale on purpose): the keeper reads it so it does
  // not raise a stale-index alert, and the app shows a notice on its page.
  app.get("/v1/rotation", async (c) => {
    const r = await d.store.activeRotation();
    return c.json({ rotating: r ? [r.identifier] : [], since: r ? Math.floor(r.startedAt.getTime() / 1000) : null, replacement: r?.replacement ?? null });
  });

  // Link paste: a signed-in account proposes a trend and is its surfacer (the first surfacer of a
  // listed trend earns curation fees). Links always wait for a reviewer.
  app.post("/v1/links", rateLimit(6, 3_600_000, ipLimit, now), signedIn, async (c) => {
    const parsed = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const surfacer = c.get("user").toLowerCase();
    if (parsed.data.surfacer && parsed.data.surfacer.toLowerCase() !== surfacer) return c.json({ error: "links are credited to the signed-in account" }, 403);
    if ((await d.store.recentLinkRequests(surfacer, 86_400)) >= LINKS_PER_ACCOUNT_PER_DAY) return c.json({ error: "daily link limit reached for this account" }, 429);
    if (d.rings.ai && (await d.rings.ai.leftToday()) <= Math.ceil(d.cfg.AI_DAILY_CALLS * (1 - LINK_AI_SHARE))) {
      return c.json({ error: "link proposals are paused for today; try again tomorrow" }, 429);
    }
    const requestId = await d.store.addLinkRequest(parsed.data.url, surfacer);
    try {
      const info = await resolveLink(parsed.data.url, d.fetchImpl);
      const { results } = await assess(
        d.ai,
        [{ kind: "link", url: info.url, platform: info.platform, title: info.title, author: info.author, text: info.text }],
        await d.store.knownIdentifiers(),
      );
      const a = results[0];
      if (!a) {
        await d.store.finishLinkRequest(requestId, "failed", null, "could not identify a topic");
        return c.json({ requestId, status: "failed", reason: "We could not tell what that link is about." }, 422);
      }
      const p = await d.radar.propose(a, "link", { url: info.url, platform: info.platform, title: info.title }, surfacer);
      await d.store.finishLinkRequest(requestId, p.status === "rejected" ? "rejected" : "proposed", p.id, p.reason);
      return c.json({ requestId, status: p.status, identifier: p.identifier, displayName: a.displayName, summary: a.summary, reason: p.reason, firstSurfacer: p.created });
    } catch (e) {
      const reason = e instanceof LinkError ? e.message : "the link could not be processed";
      await d.store.finishLinkRequest(requestId, "failed", null, reason);
      if (!(e instanceof LinkError)) d.log.warn({ err: e instanceof Error ? e.message : String(e) }, "link request failed");
      return c.json({ requestId, status: "failed", reason }, e instanceof LinkError ? 422 : 502);
    }
  });

  // The oracle's reads.
  const oracle = new Hono();
  oracle.use("*", bearer(d.cfg.ORACLE_TOKEN));
  // The queue in priority order (see queue.ts): only candidates with a reading the workflow still
  // accepts, and crypto only once smart money confirms it, so the workflow's turns go to
  // candidates that can become trends.
  oracle.get("/candidates", async (c) => {
    const approved = await d.store.candidates("approved", 200);
    const latest = await d.store.latest(approved.map((a) => a.identifier));
    const tradable = new Set((await d.autopilot.service.markets().catch(() => [])).map((m) => m.symbol.toUpperCase()));
    const [pins, watchers] = await Promise.all([d.store.pins(), d.store.watchCounts(approved.map((a) => a.id))]);
    const { queue: ranked, picks } = rankWithPicks(approved, latest, { nowSec: Math.floor(now() / 1000), confirmNetflowUsd: d.cfg.CRYPTO_CONFIRM_NETFLOW_USD, tradable, pinned: pins }, watchers);
    const rotation = await d.store.activeRotation();
    return c.json({
      // `pinned`: kept by an admin; the workflow tries it first and lists crypto without smart-money inflow.
      // `pick`: a community pick; the workflow tries it right after kept topics, with every listing check.
      // `reviewHash`: the NEAR AI Cloud review the registry stores with the listing (GET /v1/reviews/<hash>).
      candidates: ranked.map((a) => ({
        identifier: a.identifier,
        keywords: a.keywords.slice(0, 5),
        surfacer: a.surfacer,
        ticker: a.ticker,
        reviewHash: a.reviewHash,
        ...(pins.has(a.identifier) ? { pinned: true } : picks.has(a.identifier) ? { pick: true } : {}),
      })),
      // The workflow stops updating these (see rotation.ts) and counts their slots as free.
      rotating: rotation ? [rotation.identifier] : [],
    });
  });
  oracle.get("/measurements", async (c) => {
    const tracked = await d.collector.tracked();
    const asked = (c.req.query("ids") ?? "").split(",").map((s) => baseOf(s.trim().toLowerCase())).filter(Boolean);
    const wanted = asked.length > 0 ? new Set(asked) : null;
    const rows = tracked.filter((t) => !wanted || wanted.has(t.identifier));
    const latest = await d.store.latest(rows.map((t) => t.identifier));
    return c.json({
      observedAt: Math.floor(now() / 1000),
      trends: Object.fromEntries(
        rows.map((t) => [t.identifier, { keywords: t.keywords, article: t.article, ticker: t.ticker, readings: readings(latest.get(t.identifier)) }]),
      ),
    });
  });
  app.route("/v1/oracle", oracle);

  // Sign-ins, before the routes that check them: the app's account sessions, the vault identity,
  // and every admin request signed by a wallet (bearer tokens skip it; they cost no chain read).
  const signInLimit = rateLimit(SIGN_INS_PER_WINDOW, SIGN_IN_WINDOW_MS, (c) => `sign-in:${ipLimit(c)}`, now);
  app.use("/v1/auth/session", signInLimit);
  app.use("/v1/identity/session", signInLimit);
  const adminSignedLimit = rateLimit<{ Variables: { admin: string; token: string | null } }>(SIGN_INS_PER_WINDOW, SIGN_IN_WINDOW_MS, (c) => `admin-signed:${ipLimit(c)}`, now);

  // Admin, signed by an allowlisted wallet.
  const admin = new Hono<{ Variables: { admin: string; token: string | null } }>();
  admin.use("*", (c, next) => (/^Bearer\s/i.test(c.req.header("authorization") ?? "") ? next() : adminSignedLimit(c, next)));
  admin.use("*", adminAuth(d.nearReads.accessKey, d.cfg.ADMIN_ACCOUNTS, d.adminSessionSecret, (h) => d.store.isRevoked(h), now));
  admin.get("/health", async (c) => {
    const h = await healthDetail();
    return c.json(h, h.ok ? 200 : 503);
  });
  // Each service's own health in detail: its wallets, alerts and, for the top-up service, the treasury.
  admin.get("/services", async (c) => c.json({ services: await serviceDetails(parseServices(d.cfg.STATUS_SERVICES)) }));
  // Everything at once for the system view: services, chain and indexer, oracle, Elfa keys, sources,
  // RPC providers, wallets and recent errors, with what is wrong ranked first. It spends no credits.
  admin.get("/system", async (c) => {
    if (!d.system) return c.json({ error: "the system view is not configured" }, 404);
    return c.json(await d.system.report());
  });
  // Checks every Elfa key's status (one credit each) in the background, one key at a time; the
  // system report shows each result as it lands. One check at a time, and a minute after the last.
  let elfaCheckAt = 0;
  let elfaChecking = false;
  admin.post("/system/elfa-check", async (c) => {
    const system = d.system;
    const check = d.elfaCheck;
    if (!system || !check) return c.json({ error: "no Elfa keys are configured" }, 404);
    if (elfaChecking) return c.json({ error: "a key check is already running" }, 429, { "Retry-After": "30" });
    const wait = elfaCheckAt + ELFA_CHECK_INTERVAL_MS - now();
    if (wait > 0) return c.json({ error: "keys were checked moments ago; try again in a minute" }, 429, { "Retry-After": String(Math.max(1, Math.ceil(wait / 1000))) });
    elfaChecking = true;
    let latest: readonly KeyCheck[] = [];
    system.noteKeyCheck([], { running: true });
    void check((done) => {
      latest = done;
      system.noteKeyCheck([...done], { running: true });
    })
      .then((all) => system.noteKeyCheck(all, { running: false }))
      .catch((e: Error) => {
        d.log.warn({ err: e.message }, "elfa key check failed");
        system.noteKeyCheck([...latest], { running: false });
      })
      .finally(() => {
        elfaChecking = false;
        elfaCheckAt = now();
      });
    d.log.info({ by: c.get("admin") }, "elfa key check started from the admin panel");
    const report = await system.report(0);
    return c.json({ check: report.elfa.lastCheck }, 202);
  });
  // Signs the session token out everywhere, not just in the tab that holds it.
  admin.post("/session/revoke", async (c) => {
    const token = c.get("token");
    if (!token) return c.json({ error: "sign out applies to session tokens" }, 400);
    const expiry = tokenExpiry(token);
    await d.store.revoke(tokenHash(token), expiry);
    return c.json({ ok: true });
  });
  // Exchanges one signed request for a bearer token, so the admin UI asks the wallet once. Only a
  // freshly signed request mints one: a bearer token cannot renew itself past its expiry or sign-out.
  admin.post("/session", (c) => {
    if (c.get("token") !== null) return c.json({ error: "sign this request with the admin wallet" }, 403);
    const expiresAt = Math.floor(now() / 1000) + ADMIN_SESSION_SEC;
    return c.json({ token: issueSession(d.adminSessionSecret, c.get("admin"), expiresAt), account: c.get("admin"), expiresAt });
  });
  admin.get("/candidates", async (c) => {
    const status = c.req.query("status");
    const valid: CandidateStatus[] = ["pending", "approved", "rejected", "live", "retired"];
    const rows = await d.store.candidates(valid.includes(status as CandidateStatus) ? (status as CandidateStatus) : null, 300);
    return c.json({ candidates: rows.map((r) => candidateJson(r, true)) });
  });
  // A topic an admin adds by hand ("manual"): approved at once and credited to the admin, with no
  // AI review (no review hash, so the app shows no Verified chip for it). It waits in the queue
  // like any approved candidate until the oracle lists it.
  admin.post("/candidates", async (c) => {
    const b = z
      .object({
        identifier: z.string().refine(isNormalized, "identifiers use a-z, 0-9 and :._- only").refine((i) => i.includes(":"), "prefix the identifier with its class, for example topic:"),
        displayName: z.string().trim().min(1).max(40),
        keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(5),
        article: z.string().trim().max(200).nullable().default(null),
        summary: z.string().trim().max(140).nullable().default(null),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad request" }, 400);
    const identifier = baseOf(b.data.identifier);
    const assetClass = assetClassOf(identifier);
    const { candidate, created } = await d.store.insertCandidate({
      identifier,
      displayName: b.data.displayName,
      assetClass,
      keywords: b.data.keywords,
      article: b.data.article,
      ticker: tickerOf(identifier),
      summary: b.data.summary,
      source: "manual",
      sourceRef: { addedBy: c.get("admin") },
      surfacer: c.get("admin"),
      status: "approved",
      confidence: 1,
      ai: {},
      decidedBy: c.get("admin"),
      reviewHash: null,
    });
    if (!created) return c.json({ error: "a candidate with that identifier already exists", candidate: candidateJson(candidate, true) }, 409);
    radarCache = null;
    d.log.info({ identifier, by: c.get("admin") }, "candidate added by an admin");
    return c.json({ candidate: candidateJson(candidate, true) }, 201);
  });
  admin.post("/candidates/:id/decision", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!Number.isInteger(id) || !parsed.success) return c.json({ error: parsed.success ? "bad id" : (parsed.error.issues[0]?.message ?? "bad request") }, 400);
    const b = parsed.data;
    if (b.identifier && b.identifier !== baseOf(b.identifier)) return c.json({ error: "use the base identifier; versions are assigned on listing" }, 400);
    const row = await d.store
      .decide(id, b.decision === "approve" ? "approved" : "rejected", c.get("admin"), {
        identifier: b.identifier,
        displayName: b.displayName,
        keywords: b.keywords,
        article: b.article,
        summary: b.summary,
      })
      .catch((e: Error) => {
        if (/unique/i.test(e.message)) return "duplicate" as const;
        throw e;
      });
    if (row === "duplicate") return c.json({ error: "another candidate already uses that identifier" }, 409);
    if (!row) return c.json({ error: "no such candidate, or it is already live" }, 404);
    d.log.info({ id, decision: b.decision, by: c.get("admin") }, "candidate decided");
    return c.json({ candidate: candidateJson(row, true) });
  });
  // Rotation: the rules, the running rotation, recent ones, and each live trend with its pin and
  // which of the rules it meets now (see rotation.ts).
  const rotationJson = (r: Rotation) => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null });
  admin.get("/rotation", async (c) => {
    const nowSec = Math.floor(now() / 1000);
    const [trends, meta, pins, active, recent] = await Promise.all([d.chain.trends(), d.store.trendMeta(), d.store.pins(), d.store.activeRotation(), d.store.rotations(10)]);
    const live = trends.filter((t) => t.status === "Active" || t.status === "Cooling");
    const sorted = live.map((t) => t.index).sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    const median = sorted.length === 0 ? null : sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
    // The fourth rule: fewer mentions than the strongest candidate ready to list (as the collector ranks them).
    const approved = await d.store.candidates("approved", 500);
    const latest = await d.store.latest([...new Set([...approved.map((x) => x.identifier), ...live.map((t) => baseOf(t.identifier))])]);
    const ready = rankQueue(approved, latest, { nowSec, confirmNetflowUsd: d.cfg.CRYPTO_CONFIRM_NETFLOW_USD, tradable: new Set(), pinned: pins });
    const picks = communityPicks(
      ready.filter((r) => !pins.has(r.identifier)),
      await d.store.watchCounts(ready.map((r) => r.id)),
      { minWatchers: d.cfg.PICK_MIN_WATCHERS, max: d.cfg.PICK_MAX },
    );
    const strongest = ready.reduce<{ identifier: string; mentions: number } | null>((best, x) => {
      const n = mentionsOf(latest.get(x.identifier), nowSec);
      return !best || n > best.mentions ? { identifier: x.identifier, mentions: Math.round(n) } : best;
    }, null);
    const liveBases = new Set(live.map((t) => baseOf(t.identifier)));
    return c.json({
      strongest,
      // Kept topics not live now (retired, waiting to list again first in line).
      keptWaiting: [...pins].filter((b) => !liveBases.has(b)).sort(),
      // Community picks: tried right after kept topics (most awaited first).
      picks: [...picks].map(([identifier, watchers]) => ({ identifier, watchers })),
      pickRules: { minWatchers: d.cfg.PICK_MIN_WATCHERS, max: d.cfg.PICK_MAX },
      rules: { enabled: d.cfg.ROTATION === "on", maxLive: d.cfg.MAX_LIVE_TRENDS, minAgeSec: d.cfg.ROTATION_MIN_AGE_SEC, fadeRatio: d.cfg.ROTATION_FADE_RATIO, timeoutSec: d.cfg.ROTATION_TIMEOUT_SEC, listGraceSec: d.cfg.ROTATION_LIST_GRACE_SEC, cooldownSec: d.cfg.ROTATION_COOLDOWN_SEC },
      median,
      active: active ? rotationJson(active) : null,
      recent: recent.map(rotationJson),
      live: live
        .map((t) => ({
          identifier: t.identifier,
          base: baseOf(t.identifier),
          displayName: (meta.get(t.identifier) ?? meta.get(baseOf(t.identifier)))?.displayName ?? null,
          status: t.status.toLowerCase(),
          index: t.index,
          peakIndex: t.peakIndex,
          ageSec: nowSec - t.createdAt,
          pinned: pins.has(baseOf(t.identifier)),
          rotatingOut: active?.identifier === t.identifier,
          mentions: Math.round(mentionsOf(latest.get(baseOf(t.identifier)), nowSec)),
          meets: {
            age: nowSec - t.createdAt >= d.cfg.ROTATION_MIN_AGE_SEC,
            faded: t.peakIndex > 0 && t.index <= d.cfg.ROTATION_FADE_RATIO * t.peakIndex,
            belowMedian: median !== null && t.index < median,
            weaker: strongest !== null && mentionsOf(latest.get(baseOf(t.identifier)), nowSec) < strongest.mentions,
          },
        }))
        .sort((a, b) => a.index - b.index),
    });
  });
  admin.post("/pins", async (c) => {
    const parsed = z.object({ identifier: z.string().min(3).max(64), pinned: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
    const base = baseOf(parsed.data.identifier.toLowerCase());
    // Only a live trend can be kept: a crypto topic lists on smart-money inflow first, and only a
    // pin made after that lets it list again without it. Unpinning always works.
    if (parsed.data.pinned) {
      const live = (await d.chain.trends()).some((t) => (t.status === "Active" || t.status === "Cooling") && baseOf(t.identifier) === base);
      if (!live) return c.json({ error: "only a live trend can be kept" }, 409);
    }
    await d.store.setPin(base, parsed.data.pinned, c.get("admin"));
    // Keeping a trend that is rotating out calls its rotation off; the workflow resumes its updates.
    const active = await d.store.activeRotation();
    if (parsed.data.pinned && active?.base === base) await d.store.finishRotation(active.id, "cancelled", "kept by an admin");
    d.log.info({ identifier: base, pinned: parsed.data.pinned, by: c.get("admin") }, "trend pin changed");
    return c.json({ identifier: base, pinned: parsed.data.pinned });
  });
  admin.post("/rotation/cancel", async (c) => {
    const active = await d.store.activeRotation();
    if (!active) return c.json({ error: "no rotation is running" }, 404);
    await d.store.finishRotation(active.id, "cancelled", "called off by an admin");
    d.log.info({ identifier: active.identifier, by: c.get("admin") }, "rotation called off");
    return c.json({ cancelled: active.identifier });
  });
  // Runs take a minute or more, so they start in the background; /health shows the outcome.
  admin.post("/jobs/:name/run", (c) => {
    const name = c.req.param("name");
    if (name !== "radar" && name !== "collector" && name !== "history") return c.json({ error: "no such job" }, 404);
    return c.json({ started: d.jobs.trigger(name) }, 202);
  });
  const autopilotDeps = {
    isRevoked: (h: string) => d.store.isRevoked(h),
    revoke: (h: string, expiresAt: number) => d.store.revoke(h, expiresAt),
    store: d.autopilot.store,
    service: d.autopilot.service,
    hyperliquid: d.hyperliquid,
    sessions: d.nearReads.session,
    accessKey: d.nearReads.accessKey,
    view: <T>(contractId: string, method: string, args: object) => d.chain.viewer.view<T>(contractId, method, args),
    signer: d.cfg.deployment.external.chainSignatures,
    keys,
    approvals,
    sessionSecret: d.adminSessionSecret,
    sealPublicKey: d.cfg.AUTOPILOT_SEAL_PUBLIC_KEY,
    botAccount: d.cfg.AUTOPILOT_BOT_ACCOUNT,
    log: d.log,
    now,
  };
  admin.route("/", autopilotAdminRoutes(autopilotDeps));
  admin.route("/", moderationRoutes({ sql: d.store.sql }));
  admin.route("/", waitlistAdminRoutes({ sql: d.store.sql }));
  app.route("/v1/admin", admin);
  app.route("/v1", autopilotRoutes(autopilotDeps));
  // Any-chain deposits and withdrawals through NEAR Intents (dry quotes on testnet).
  app.route("/v1", depositRoutes({ sql: d.store.sql, oneClick: d.oneClick, network: d.cfg.NEAR_NETWORK, signedIn, log: d.log, now }));
  app.route("/v1", socialRoutes({ sql: d.store.sql, chain: d.chain, approvals, sessionSecret: d.adminSessionSecret, isRevoked: (h) => d.store.isRevoked(h), now }));
  app.route("/v1", ownerApprovalRoutes(approvals, signedIn, now));
  // Sign-up: the relayer pays for an activation only with this API's ticket.
  app.route("/v1", activationTicketRoutes(d.tickets ?? null, d.cfg.TRUSTED_PROXY_HOPS, now));
  // The Mainnet waitlist, from the app and the website. Client addresses are stored as keyed hashes.
  app.route("/v1", waitlistRoutes({ sql: d.store.sql, trustedProxyHops: d.cfg.TRUSTED_PROXY_HOPS, ipSecret: d.adminSessionSecret, now }));

  // Web Push subscriptions for the signed-in account's devices.
  const subscription = z.object({
    endpoint: z.string().max(1000).refine(isPushEndpoint, "push endpoints must be a browser push service (https)"),
    keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(10).max(100) }),
    topics: z.array(z.enum(TOPICS as [Topic, ...Topic[]])).min(1).default([...TOPICS]),
  });
  app.get("/v1/push/vapid", (c) => (d.push.vapid ? c.json({ publicKey: d.push.vapid.publicKey }) : c.json({ error: "push is not configured" }, 503)));
  // Attention alerts (alerts.ts): set on a live topic, kept per account, checked every minute and
  // pushed under the "alerts" topic.
  type Vars = { Variables: { user: string; token: string } };
  const alertTarget = z.object({ trend: z.string().min(3).max(64) });
  const alertBody = z.union([
    alertTarget.extend({ kind: z.enum(["rise", "drop"]), changePct: z.number().min(5).max(500), windowMin: z.number().int().min(15).max(1440) }),
    alertTarget.extend({ kind: z.enum(["above", "below"]), level: z.number().gt(0).lt(100) }),
  ]);
  const liveListing = async (base: string) =>
    (await d.chain.trends())
      .filter((t) => (t.status === "Active" || t.status === "Cooling") && baseOf(t.identifier) === base)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  const alertJson = (a: Alert, live: Map<string, string>, names: Map<string, TrendMeta>) => {
    const identifier = live.get(a.base) ?? null;
    return {
      id: a.id,
      trend: a.base,
      identifier,
      name: (identifier ? names.get(identifier)?.displayName : undefined) ?? names.get(a.base)?.displayName ?? a.base,
      kind: a.kind,
      changePct: a.changePct,
      windowMin: a.windowMin,
      level: a.level,
      createdAt: a.createdAt.toISOString(),
      lastFiredAt: a.lastFiredAt?.toISOString() ?? null,
      firedCount: a.firedCount,
    };
  };
  const liveByBase = async () => {
    const out = new Map<string, string>();
    for (const t of (await d.chain.trends()).filter((x) => x.status === "Active" || x.status === "Cooling").sort((a, b) => a.createdAt - b.createdAt)) out.set(baseOf(t.identifier), t.identifier);
    return out;
  };
  app.get("/v1/alerts", signedIn, async (c) => {
    if (!d.alerts) return c.json({ error: "alerts are not available" }, 503);
    const [list, live, names] = await Promise.all([d.alerts.list(c.get("user")), liveByBase(), d.store.trendMeta()]);
    return c.json({ alerts: list.map((a) => alertJson(a, live, names)), max: MAX_ALERTS });
  });
  app.post("/v1/alerts", signedIn, rateLimit<Vars>(60, 3_600_000, (c) => `alerts:${c.get("user")}`, now), async (c) => {
    if (!d.alerts) return c.json({ error: "alerts are not available" }, 503);
    const b = alertBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad alert" }, 400);
    const base = baseOf(b.data.trend.toLowerCase());
    const trend = await liveListing(base);
    if (!trend) return c.json({ error: "alerts can be set only on a live trend" }, 404);
    if ((await d.alerts.count(c.get("user"))) >= MAX_ALERTS) return c.json({ error: `you can keep up to ${MAX_ALERTS} alerts; remove one first` }, 409);
    const crossing = b.data.kind === "above" || b.data.kind === "below";
    const level = "level" in b.data ? b.data.level : null;
    // A crossing set past its level waits for the next crossing instead of firing at once.
    const past = level !== null && (b.data.kind === "above" ? trend.index >= level : trend.index <= level);
    const alert = await d.alerts.create(c.get("user"), {
      base,
      kind: b.data.kind,
      changePct: "changePct" in b.data ? b.data.changePct : null,
      windowMin: "windowMin" in b.data ? b.data.windowMin : null,
      level,
      armed: !(crossing && past),
    });
    const [live, names] = await Promise.all([liveByBase(), d.store.trendMeta()]);
    return c.json({ alert: alertJson(alert, live, names), alreadyPast: crossing && past }, 201);
  });
  app.delete("/v1/alerts/:id", signedIn, async (c) => {
    if (!d.alerts) return c.json({ error: "alerts are not available" }, 503);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    if (!(await d.alerts.remove(c.get("user"), id))) return c.json({ error: "no such alert" }, 404);
    return c.json({ removed: id });
  });

  app.post("/v1/push/subscriptions", signedIn, async (c) => {
    const b = subscription.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad subscription" }, 400);
    const stored = await d.push.subscribe(c.get("user"), { endpoint: b.data.endpoint, p256dh: b.data.keys.p256dh, auth: b.data.keys.auth, topics: b.data.topics });
    if (!stored) return c.json({ error: "another account receives notifications on this browser; it must turn them off first" }, 409);
    return c.json({ ok: true }, 201);
  });
  app.delete("/v1/push/subscriptions", signedIn, async (c) => {
    const b = z.object({ endpoint: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "endpoint required" }, 400);
    await d.push.unsubscribe(c.get("user"), b.data.endpoint);
    return c.json({ ok: true });
  });

  // Testnet USDC comes from the test USDC contract's own faucet: accounts draw it on chain (passkey
  // accounts through their session, gas-free), once per cooldown. This says what it pays and when
  // an account may draw again.
  app.get("/v1/faucet", async (c) => {
    if (d.cfg.NEAR_NETWORK !== "testnet") return c.json({ available: false });
    const account = c.req.query("account");
    const [amount, cooldownSec, last] = await d.chain.viewer.view<[string, number, number | null]>(d.cfg.deployment.contracts.usdc, "faucet_info", { account_id: account && isAccount(account) ? account : null });
    return c.json({ available: true, contract: d.cfg.deployment.contracts.usdc, amount, cooldownSec, nextAt: last === null ? null : last + cooldownSec });
  });

  // The signed evidence behind a listing's AI review (ai/nearai.ts): its hash is what the registry
  // stores with the trend, and the bundle re-checks at NEAR AI Cloud's verifier.
  app.get("/v1/reviews/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: "bad review hash" }, 400);
    const r = await d.store.review(hash);
    if (!r) return c.json({ error: "no such review" }, 404);
    return c.json({ hash: r.hash, evidence: r.evidence, createdAt: r.createdAt.toISOString() });
  });

  // Public status: every service, the oracle and the chain head, as up or down. Cached briefly.
  let statusCache: { at: number; body: Awaited<ReturnType<typeof status>> } | null = null;
  app.get("/v1/status", async (c) => {
    if (!statusCache || now() - statusCache.at > 10_000) {
      const rotating = await d.store.activeRotation().catch(() => null);
      statusCache = {
        at: now(),
        body: await status(d.chain, parseServices(d.cfg.STATUS_SERVICES), { oracleStaleSec: d.cfg.ORACLE_STALE_SEC, rotating: new Set(rotating ? [rotating.identifier] : []) }, Math.floor(now() / 1000)),
      };
    }
    return c.json(statusCache.body, statusCache.body.ok ? 200 : 503);
  });

  return app;
}
