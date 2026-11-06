import { randomBytes } from "node:crypto";
import { Ai, type Provider } from "./ai/providers";
import { nearAi, nearAiClient } from "./ai/nearai";
import { createApp } from "./api/app";
import { KeyRing } from "./budget";
import { ChainReader } from "./chain";
import { Collector } from "./collector";
import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { log } from "./log";
import { HyperliquidInfo } from "@tredio/hyperliquid";
import { OneClick } from "@tredio/intents";
import { AutopilotService } from "./autopilot/service";
import { AutopilotStore } from "./autopilot/store";
import { IndexHistory } from "./history";
import { ActivationTickets } from "./activation/tickets";
import { Jobs } from "./jobs";
import { Alerts } from "./alerts";
import { baseOf } from "./identifiers";
import { Dispatcher } from "./notify/dispatcher";
import { Push } from "./notify/push";
import { resolveCalls } from "./social/routes";
import { DEFAULT_RADAR, Radar } from "./radar";
import { Bluesky } from "./sources/bluesky";
import { CoinGecko } from "./sources/coingecko";
import { Elfa, type KeyCheck } from "./sources/elfa";
import { routeElfaKeys } from "./sources/elfa-proxies";
import { CallPacer } from "./sources/pacer";
import { ProxyFallback } from "./sources/proxy-pool";
import { Gdelt } from "./sources/gdelt";
import { GeckoTerminal } from "./sources/geckoterminal";
import { HackerNews } from "./sources/hackernews";
import { Nansen } from "./sources/nansen";
import { hasContact, Wikipedia } from "./sources/wikipedia";
import { Store } from "./store";
import { IndexerReader } from "./indexer";
import { backendErrors } from "./errors";
import { SourceStats } from "./sources/stats";
import { secretsOf, SystemMonitor } from "./system";
import { accessKeyReader } from "./api/near-auth";
import type { SessionView } from "./api/user-auth";

const startedAt = Date.now();
const cfg = loadConfig(process.env);
const sql = connect(cfg.DATABASE_URL);
const applied = await migrate(sql);
log.info({ migrations: applied.length, network: cfg.NEAR_NETWORK, rpcEndpoints: cfg.rpc.length }, "database ready");

const store = new Store(sql);
const chain = new ChainReader(cfg.rpc, cfg.deployment);
// The first page view should not pay for the first registry read.
void chain.trends().catch((e: Error) => log.warn({ err: e.message }, "registry warm-up failed"));

const elfaRouting = routeElfaKeys(cfg.ELFA_API_KEYS, cfg.ELFA_PROXIES);
if (cfg.ELFA_API_KEYS.length > 0) {
  log.info({ keys: elfaRouting.mapping, unusedProxies: elfaRouting.unused }, "elfa key routes");
  if (elfaRouting.skipped.length > 0) log.warn({ skipped: elfaRouting.skipped }, "elfa keys without a proxy are not used");
}
const elfaProxies = new Map(elfaRouting.routes.map((r) => [r.keyId, r.proxy]));
const elfaRing =
  elfaRouting.routes.length > 0
    ? new KeyRing(
        sql,
        "elfa",
        elfaRouting.routes.map((r) => r.key),
        { daily: cfg.ELFA_DAILY_CREDITS_PER_KEY, monthly: cfg.ELFA_MONTHLY_CREDITS_PER_KEY, hourlySlack: cfg.ELFA_HOURLY_SLACK },
      )
    : null;
// Elfa calls go out one at a time, spaced apart, each key resting between its own uses.
const elfaPacer = new CallPacer("elfa", {
  minGapMs: cfg.ELFA_MIN_GAP_SEC * 1000,
  maxGapMs: cfg.ELFA_MAX_GAP_SEC * 1000,
  keyGapMs: cfg.ELFA_KEY_MIN_GAP_SEC * 1000,
  keyJitter: 0.3,
});
// Every source's requests are counted for the admin system view (sources/stats.ts).
const sourceStats = new SourceStats(backendErrors);
const elfa = elfaRing
  ? new Elfa(elfaRing, cfg.ELFA_API_BASE, sourceStats.track("elfa", fetch), (id) => elfaProxies.get(id) ?? null, true, {
      pacer: elfaPacer,
      checkGapMs: [cfg.ELFA_CHECK_GAP_MIN_SEC * 1000, cfg.ELFA_CHECK_GAP_MAX_SEC * 1000],
    })
  : null;
const nansenRing = cfg.NANSEN_API_KEYS.length > 0 ? new KeyRing(sql, "nansen", cfg.NANSEN_API_KEYS, { daily: cfg.NANSEN_DAILY_CREDITS_PER_KEY }) : null;
const nansen = nansenRing ? new Nansen(nansenRing, cfg.NANSEN_API_BASE, cfg.NANSEN_CHAINS, sourceStats.track("nansen", fetch)) : null;
// Keyless sources only; nothing keyed ever gets this fetch.
const proxyFallback = new ProxyFallback(
  elfaRouting.routes.map((r) => r.proxy),
  { capBytes: cfg.PROXY_FALLBACK_MB_PER_MONTH * 1024 * 1024, busy: () => elfa?.busyProxies() ?? new Set() },
);
const keylessFetch = proxyFallback.wrap(fetch);
const wikipedia = new Wikipedia(cfg.WIKIMEDIA_USER_AGENT, "en.wikipedia", sourceStats.track("wikipedia", keylessFetch));
// GDELT paces itself and takes the next lane after a refusal, so it never goes through the
// fallback's own retry; it may spend at most half of the month's fallback budget.
const gdelt = new Gdelt(fetch, undefined, undefined, {
  lanes: [{ id: "direct", fetch }, ...proxyFallback.lanes(fetch, { share: 0.5 })].map((l) => ({ ...l, fetch: sourceStats.track("gdelt", l.fetch) })),
});
// Keyless public APIs, each on its own paced queue.
const keyless = (name: string) => ({ userAgent: cfg.WIKIMEDIA_USER_AGENT, fetchImpl: sourceStats.track(name, keylessFetch) });
const bluesky = new Bluesky(undefined, keyless("bluesky"));
const hn = new HackerNews(undefined, keyless("hn"));
const coingecko = new CoinGecko(undefined, keyless("coingecko"));
const geckoterminal = new GeckoTerminal(undefined, keyless("geckoterminal"));

// The review cascade: NEAR AI Cloud's verifiable models, cheapest first; every answer is checked
// with verifyResponse(), and its signed evidence and the exact bodies it covers are kept (ai/nearai.ts).
const providers: Provider[] = [];
if (cfg.NEARAI_API_KEY) {
  const client = nearAiClient(cfg.NEARAI_API_KEY, cfg.NEARAI_API_BASE);
  for (const model of cfg.NEARAI_MODELS) providers.push(nearAi(client, model));
}
// One allowance of AI provider requests per UTC day, shared by the radar and pasted links.
const aiRing = new KeyRing(sql, "ai", ["daily"], { daily: cfg.AI_DAILY_CALLS });
const ai = new Ai(providers, (message, fields) => log.warn(fields, message), Date.now, aiRing);

const history = new IndexHistory(sql, chain);
// The indexer may share the database (its own schema) or live in another one.
const indexerSql = cfg.INDEXER_DATABASE_URL && cfg.INDEXER_DATABASE_URL !== cfg.DATABASE_URL ? connect(cfg.INDEXER_DATABASE_URL, 4) : cfg.INDEXER_DATABASE_URL ? sql : null;
const indexer = indexerSql ? new IndexerReader(indexerSql, cfg.INDEXER_SCHEMA) : null;
const oneClick = new OneClick({ baseUrl: cfg.ONECLICK_API_BASE, jwt: cfg.ONECLICK_JWT ?? null });
const hyperliquid = new HyperliquidInfo(cfg.NEAR_NETWORK);
const autopilot = {
  store: new AutopilotStore(sql),
  service: new AutopilotService(sql, chain, history, hyperliquid, { takerFeeBps: cfg.HL_TAKER_FEE_BPS, slippageBps: cfg.BACKTEST_SLIPPAGE_BPS }),
};
const radar = new Radar(
  store,
  elfa,
  wikipedia,
  ai,
  {
    ...DEFAULT_RADAR,
    narrativesEvery: cfg.NARRATIVES_EVERY,
    tokensEvery: cfg.ELFA_TOKENS_EVERY,
    autoApproveConfidence: cfg.AUTO_APPROVE_CONFIDENCE,
    priorityTickers: async () => (await autopilot.service.markets()).map((m) => m.symbol),
  },
  log,
  { bluesky, coingecko, geckoterminal },
);

const radarRunsPerDay = 86_400 / cfg.RADAR_INTERVAL_SEC;
const collector = new Collector(
  store,
  chain,
  { elfa: elfa && elfaRing ? { client: elfa, ring: elfaRing } : null, gdelt, nansen, wikipedia, bluesky, hn },
  {
    rotation:
      cfg.ROTATION === "on"
        ? {
            maxLive: cfg.MAX_LIVE_TRENDS,
            minAgeSec: cfg.ROTATION_MIN_AGE_SEC,
            fadeRatio: cfg.ROTATION_FADE_RATIO,
            timeoutSec: cfg.ROTATION_TIMEOUT_SEC,
            listGraceSec: cfg.ROTATION_LIST_GRACE_SEC,
            staleWindowSec: cfg.ROTATION_STALE_WINDOW_SEC,
            cooldownSec: cfg.ROTATION_COOLDOWN_SEC,
            confirmNetflowUsd: cfg.CRYPTO_CONFIRM_NETFLOW_USD,
          }
        : undefined,
    elfaRefreshSec: cfg.ELFA_REFRESH_SEC,
    gdeltRefreshSec: cfg.GDELT_REFRESH_SEC,
    gdeltCandidateRefreshSec: cfg.GDELT_CANDIDATE_REFRESH_SEC,
    nansenRefreshSec: cfg.NANSEN_REFRESH_SEC,
    wikipediaRefreshSec: cfg.WIKIPEDIA_REFRESH_SEC,
    // Trending tokens cost 1 credit every ELFA_TOKENS_EVERY runs, narratives 5 every NARRATIVES_EVERY runs while a key may read them.
    elfaRadarCreditsPerDay: () => Math.ceil(radarRunsPerDay * (1 / cfg.ELFA_TOKENS_EVERY + (elfa?.narrativesAvailable ? 5 / cfg.NARRATIVES_EVERY : 0))),
    // A GDELT request takes 10 to 25 s plus a 6 to 10 s gap: a few per tick, within a time budget.
    maxGdeltPerTick: Math.max(1, Math.floor(cfg.COLLECT_INTERVAL_SEC / 20)),
    // Leaves Wikimedia headroom for the radar's title checks.
    maxWikipediaPerTick: Math.max(1, Math.floor((cfg.COLLECT_INTERVAL_SEC / 60) * (hasContact(cfg.WIKIMEDIA_USER_AGENT) ? 60 : 5))),
    blueskyRefreshSec: cfg.BLUESKY_REFRESH_SEC,
    hnRefreshSec: cfg.HN_REFRESH_SEC,
    // Bluesky searches go a second apart, Hacker News up to three half a second apart: both finish well inside a tick.
    maxBlueskyPerTick: Math.max(1, Math.floor(cfg.COLLECT_INTERVAL_SEC / 6)),
    maxHnPerTick: Math.max(1, Math.floor(cfg.COLLECT_INTERVAL_SEC / 6)),
  },
  log,
);

const push = new Push(
  sql,
  cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY && cfg.VAPID_SUBJECT ? { publicKey: cfg.VAPID_PUBLIC_KEY, privateKey: cfg.VAPID_PRIVATE_KEY, subject: cfg.VAPID_SUBJECT } : null,
);
const dispatcher = new Dispatcher(sql, push);
const alerts = new Alerts(
  sql,
  push,
  () => chain.trends(),
  (trendId, sinceSec) => history.points(trendId, sinceSec),
  async (identifiers) => {
    const meta = await store.trendMeta();
    return new Map(identifiers.map((i) => [i, meta.get(i)?.displayName ?? meta.get(baseOf(i))?.displayName ?? i]));
  },
);
// On-chain reads the API's auth needs: an account's access keys, its sessions and its passkey key.
const rpc = <T>(method: string, params: unknown) => chain.viewer.rpc<T>(method, params);
const missing = (e: unknown) => /UNKNOWN_ACCOUNT|does not exist|CodeDoesNotExist|MethodNotFound|wasm execution failed/i.test(String((e as Error)?.message ?? e));
const nearReads = {
  accessKey: accessKeyReader(rpc),
  session: async (account: string, publicKey: string) => {
    try {
      return await chain.viewer.view<SessionView | null>(account, "session", { public_key: publicKey });
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  },
  ownerKey: async (account: string) => {
    try {
      return await chain.viewer.view<string>(account, "owner_key");
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  },
};
const tickets = cfg.ACTIVATION_TICKET_KEY
  ? new ActivationTickets(
      sql,
      {
        accountIdOf: (ownerKey) => chain.viewer.view<string>(cfg.deployment.contracts.accounts, "account_id_of", { owner_key: ownerKey }),
        exists: async (account) => {
          try {
            await rpc("query", { request_type: "view_account", finality: "final", account_id: account });
            return true;
          } catch (e) {
            if (missing(e)) return false;
            throw e;
          }
        },
      },
      cfg.ACTIVATION_TICKET_KEY,
      cfg.NEAR_NETWORK,
      {
      perIpPerHour: cfg.ACTIVATION_TICKETS_PER_IP_PER_HOUR,
      perIpPerDay: cfg.ACTIVATION_TICKETS_PER_IP_PER_DAY,
      perHour: cfg.ACTIVATION_TICKETS_PER_HOUR,
        perDay: cfg.ACTIVATION_TICKETS_PER_DAY,
      },
    )
  : null;
const jobs = new Jobs(store, log);
const adminSessionSecret = cfg.ADMIN_SESSION_SECRET ?? randomBytes(32).toString("hex");
const system = new SystemMonitor({
  network: cfg.NEAR_NETWORK,
  services: cfg.systemServices,
  oracleStaleSec: cfg.ORACLE_STALE_SEC,
  rotating: async () => {
    const r = await store.activeRotation();
    return new Set(r ? [r.identifier] : []);
  },
  jobIntervals: { collector: cfg.COLLECT_INTERVAL_SEC, radar: cfg.RADAR_INTERVAL_SEC, history: cfg.HISTORY_INTERVAL_SEC, calls: 60, notify: 15 },
  refreshSec: {
    elfa: cfg.ELFA_REFRESH_SEC,
    gdelt: cfg.GDELT_REFRESH_SEC,
    nansen: cfg.NANSEN_REFRESH_SEC,
    wikipedia: cfg.WIKIPEDIA_REFRESH_SEC,
    bluesky: cfg.BLUESKY_REFRESH_SEC,
    hn: cfg.HN_REFRESH_SEC,
  },
  store,
  chain,
  indexer: indexer ? { progress: () => indexer.progress(cfg.NEAR_NETWORK), oracle: (nowSec?: number) => indexer.oracle(nowSec) } : null,
  elfa:
    elfa && elfaRing
      ? async () => ({
          routes: elfaRouting.routes,
          skipped: elfaRouting.skipped,
          unusedRoutes: cfg.ELFA_PROXIES.slice(cfg.ELFA_API_KEYS.length),
          usage: await elfaRing.usage(),
          benches: elfaRing.benches(),
          calls: elfa.keyCalls(),
          busy: elfa.busyProxies(),
          narrativesAllowed: (id) => elfa.narrativesAllowed(id),
          narrativesAvailable: elfa.narrativesAvailable,
        })
      : null,
  elfaLimits: { dailyPerKey: cfg.ELFA_DAILY_CREDITS_PER_KEY, monthlyPerKey: cfg.ELFA_MONTHLY_CREDITS_PER_KEY },
  fallback: cfg.PROXY_FALLBACK_MB_PER_MONTH > 0 && elfaRouting.routes.length > 0 ? () => proxyFallback.stats : null,
  sources: {
    stats: () => sourceStats.report(),
    resting: {
      gdelt: () => !gdelt.available,
      bluesky: () => !bluesky.available,
      hn: () => !hn.available,
      coingecko: () => !coingecko.http.available,
      geckoterminal: () => !geckoterminal.http.available,
      elfa: () => elfa?.keysBenched ?? false,
      nansen: () => (nansenRing ? nansenRing.benched() >= nansenRing.size : false),
    },
    configured: { elfa: elfa !== null, nansen: nansen !== null },
  },
  ai: { report: () => ai.report(), leftToday: () => aiRing.leftToday(), dailyCalls: cfg.AI_DAILY_CALLS },
  errors: backendErrors,
  secrets: secretsOf({
    keys: [
      ...cfg.ELFA_API_KEYS,
      ...cfg.rpc.flatMap((e) => (e.headers?.authorization ? [e.headers.authorization.replace(/^Bearer /, "")] : [])),
      ...cfg.NANSEN_API_KEYS,
      cfg.NEARAI_API_KEY,
      cfg.ONECLICK_JWT,
      cfg.ORACLE_TOKEN,
      adminSessionSecret,
      cfg.VAPID_PRIVATE_KEY,
      cfg.ACTIVATION_TICKET_KEY,
      cfg.X402_RELAYER_KEY,
    ],
    routes: cfg.ELFA_PROXIES,
    urls: [...cfg.rpc.map((e) => e.url), cfg.DATABASE_URL, cfg.INDEXER_DATABASE_URL],
  }),
  startedAt,
});
const elfaCheck = elfa && elfaRouting.routes.length > 0 ? (onResult?: (done: readonly KeyCheck[]) => void) => elfa.checkKeys(elfaRouting.routes, onResult) : null;
const app = createApp({
  cfg,
  store,
  chain,
  nearReads,
  collector,
  radar,
  ai,
  gdelt,
  feeds: { bluesky, hn, coingecko, geckoterminal, proxyFallback },
  rings: { elfa: elfaRing, nansen: nansenRing, ai: aiRing },
  jobs,
  adminSessionSecret,
  history,
  autopilot,
  hyperliquid,
  oneClick,
  push,
  tickets,
  indexer,
  system,
  elfaCheck,
  alerts,
  log,
});
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch, idleTimeout: 60 });
log.info({ port: server.port, ai: providers.map((p) => p.name), elfaKeys: elfaRing?.size ?? 0, nansenKeys: nansenRing?.size ?? 0, activationTicketSigner: tickets?.publicKey ?? null }, "backend listening");

// Off by default: usage is counted locally and refusals are learned from normal calls. When on, it
// runs in the background, one key at a time.
if (cfg.BACKGROUND === "on" && elfa && cfg.ELFA_SYNC_USAGE === "on") {
  void elfa
    .syncUsage(elfaRouting.routes)
    .then(({ rejected, failed }) => {
      const of = elfaRouting.routes.length;
      if (rejected.length > 0) log.warn({ rejected, of }, "elfa rejected some keys as invalid or expired; they sit out and the others carry on");
      if (failed.length > 0) log.warn({ failed, of }, "elfa usage sync could not reach some keys' proxies; those keys rest and retry");
      if (!elfa.narrativesAvailable) log.info("elfa trending narratives need a paid plan; the radar reads Bluesky trends instead");
    })
    .catch((e: Error) => log.warn({ err: e.message }, "elfa usage sync failed"));
}
const start = cfg.BACKGROUND === "on";
jobs.add("collector", cfg.COLLECT_INTERVAL_SEC, () => collector.tick(), { start });
jobs.add("radar", cfg.RADAR_INTERVAL_SEC, () => radar.tick(), { start });
jobs.add("history", cfg.HISTORY_INTERVAL_SEC, () => history.sync(), { start });
jobs.add("calls", 60, () => resolveCalls(sql, chain, Math.floor(Date.now() / 1000)), { start });
jobs.add("notify", 15, () => dispatcher.tick(), { start });
jobs.add("alerts", 60, () => alerts.tick(), { start });

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  jobs.stop();
  server.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
