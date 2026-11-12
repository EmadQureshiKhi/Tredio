import { type RpcEndpoint, rpcEndpoints } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";
import { parseServices, type ServiceProbe } from "./status";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** An optional setting left empty in an env file counts as unset. */
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
/** A NEAR account id: named (`alice.testnet`) or implicit/universal (64 hex, `0u...`). */
export const accountId = z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64);
const ed25519Secret = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  /** The indexer's database (it may be the same one) and schema; history endpoints are off without it. */
  INDEXER_DATABASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  INDEXER_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("indexer"),
  /** NEAR Intents 1Click API for any-chain deposits and withdrawals (mainnet). */
  ONECLICK_API_BASE: z.string().url().default("https://1click.chaindefuser.com"),
  /**
   * Partner JWT from the NEAR Intents Partner Dashboard (https://partners.near-intents.org/home), a distribution channel key.
   * With it every 1Click quote is confidential; without it, or while 1Click refuses it, quotes are public at the same fee.
   */
  ONECLICK_JWT: optional(z.string().min(20)),
  /** Comma-separated app origins allowed by CORS. */
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  /** Comma-separated website origins allowed by CORS, for the waitlist form only. */
  LANDING_URL: z.string().default("http://localhost:3004"),
  /**
   * Proxies in front of the backend that append to X-Forwarded-For (Caddy in front: 1). 0 trusts no
   * header and rate limits by the socket address; n takes the entry n positions from the right.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** Comma-separated RPC endpoints, tried in order; FastNEAR and NEAR's own by default. */
  NEAR_RPC_URLS: optional(z.string()),
  /** FastNEAR API keys (comma-separated): requests take them in turn, ahead of the public providers. */
  FASTNEAR_API_KEYS: optional(z.string()),
  /** A deployment file's JSON, to point at contracts other than the bundled deployment. */
  DEPLOYMENT_JSON: optional(z.string()),

  /** Bearer token the oracle sends for candidates and measurements. */
  ORACLE_TOKEN: z.string().min(16),
  /** Signs admin session tokens; a random one per start when unset (sessions end on restart). */
  ADMIN_SESSION_SECRET: optional(z.string().min(32)),
  /** NEAR accounts allowed to use the admin API (NEP-413 signed requests), comma-separated. */
  ADMIN_ACCOUNTS: z.string().default("").transform((v) => list(v).map((a) => a.toLowerCase())),

  ELFA_API_KEYS: z.string().default("").transform(list),
  ELFA_API_BASE: z.string().url().default("https://api.elfa.ai"),
  /** Elfa credit budgets; the monthly budget is paced across the days left. */
  ELFA_DAILY_CREDITS_PER_KEY: z.coerce.number().int().positive().default(100),
  ELFA_MONTHLY_CREDITS_PER_KEY: z.coerce.number().int().positive().default(950),
  /** Spend each key's month by this UTC day (YYYY-MM-DD) instead of the month's end: for a deployment that runs a shorter time. */
  ELFA_SPEND_BY: z.preprocess((v) => (v === "" ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  /** Read usage from Elfa on start (one credit each) so budgets match Elfa's count. */
  ELFA_SYNC_USAGE: z.enum(["on", "off"]).default("off"),
  /** Elfa calls go out one at a time; after each, the next waits a random gap between these bounds. */
  ELFA_MIN_GAP_SEC: z.coerce.number().min(0).default(20),
  ELFA_MAX_GAP_SEC: z.coerce.number().min(0).default(90),
  /** A key rests about this long (plus or minus 30%) between its own uses. */
  ELFA_KEY_MIN_GAP_SEC: z.coerce.number().min(0).default(600),
  /** A key check goes one key at a time, a random gap between these bounds apart. */
  ELFA_CHECK_GAP_MIN_SEC: z.coerce.number().min(0).default(30),
  ELFA_CHECK_GAP_MAX_SEC: z.coerce.number().min(0).default(90),
  /** Each key's daily credits open hour by hour, with this many credits of slack. */
  ELFA_HOURLY_SLACK: z.coerce.number().int().min(0).default(2),
  ELFA_PROXIES: z.string().default("").transform(list),
  PROXY_FALLBACK_MB_PER_MONTH: z.coerce.number().int().min(0).max(800).default(300),

  NANSEN_API_KEYS: z.string().default("").transform(list),
  NANSEN_API_BASE: z.string().url().default("https://api.nansen.ai"),
  /** Nansen's free plan tops up to 10 credits a day; a netflow call costs 5. */
  NANSEN_DAILY_CREDITS_PER_KEY: z.coerce.number().int().positive().default(10),
  NANSEN_CHAINS: z.string().default("all").transform(list),

  /** Wikimedia asks every client to identify itself. */
  WIKIMEDIA_USER_AGENT: z.string().default("TredioAttentionIndex/1.0 (https://tredio.bid; contact@tredio.bid)"),

  /** NEAR AI Cloud (OpenAI-compatible): candidate review on verifiable (TEE) models only. */
  NEARAI_API_KEY: optional(z.string().min(10)),
  NEARAI_API_BASE: z.string().url().default("https://cloud-api.near.ai/v1"),
  /** The review cascade, cheapest first; every model must be `verifiable: true` on NEAR AI Cloud. */
  NEARAI_MODELS: z.string().default("z-ai/glm-5.3-flash,deepseek-ai/DeepSeek-V4.1-Flash-1017,z-ai/glm-5.3").transform(list),
  /** AI provider requests per UTC day, shared by the radar and pasted links (links may use half). */
  AI_DAILY_CALLS: z.coerce.number().int().positive().default(400),

  /** Radar cadence: Elfa trending tokens every run, narratives (5 credits) every NARRATIVES_EVERY runs. */
  RADAR_INTERVAL_SEC: z.coerce.number().int().positive().default(7200),
  NARRATIVES_EVERY: z.coerce.number().int().positive().default(6),
  /** Radar runs between Elfa trending-token calls (1 credit each); raise it when one free key must also feed the collector. */
  ELFA_TOKENS_EVERY: z.coerce.number().int().positive().default(1),
  /** AI confidence (0 to 1) at or above which a policy-clean candidate is approved without review. */
  AUTO_APPROVE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  /** Collector cadence and the shortest refresh per source for each tracked trend. */
  COLLECT_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  ELFA_REFRESH_SEC: z.coerce.number().int().positive().default(7200),
  GDELT_REFRESH_SEC: z.coerce.number().int().positive().default(1800),
  /** Candidates (not yet listed) refresh GDELT less often than live trends, within the workflow's 2 h age limit. */
  GDELT_CANDIDATE_REFRESH_SEC: z.coerce.number().int().positive().default(3600),
  NANSEN_REFRESH_SEC: z.coerce.number().int().positive().default(14400),
  WIKIPEDIA_REFRESH_SEC: z.coerce.number().int().positive().default(21600),
  /** Keyless sources: Bluesky mentions (one search per trend) and Hacker News mentions (up to three per trend). */
  BLUESKY_REFRESH_SEC: z.coerce.number().int().positive().default(1800),
  HN_REFRESH_SEC: z.coerce.number().int().positive().default(3600),
  /** The Autopilot executor's public key (base64url, P-256 raw): grants are sealed to it. */
  AUTOPILOT_SEAL_PUBLIC_KEY: optional(z.string().min(80)),
  /** The Tredio bot's own account: its rules (route "api") trade from it through its own Autopilot session. */
  AUTOPILOT_BOT_ACCOUNT: optional(accountId),
  /**
   * #mainnet: the NEAR Intents Agent API partner key (partners.near-intents.org): Autopilot grants on
   * an agent the account's passkey owns. Server side only; unused on testnet, where policy wallets are
   * OutLayer custody wallets the app makes itself.
   */
  AGENT_API_KEY: optional(z.string().min(8)),
  AGENT_API_URL: optional(z.string().url()),
  /** Backtest costs: Hyperliquid's base taker fee and a slippage allowance, basis points per fill. */
  HL_TAKER_FEE_BPS: z.coerce.number().nonnegative().default(4.5),
  BACKTEST_SLIPPAGE_BPS: z.coerce.number().nonnegative().default(5),
  HISTORY_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  /** Smart-money inflow (USD, 24h) a crypto candidate needs before it is offered to the workflow; keep equal to the workflow's minConfirmNetflowUsd. */
  CRYPTO_CONFIRM_NETFLOW_USD: z.coerce.number().nonnegative().default(100_000),
  // Community picks (queue.ts communityPicks): accounts waiting on a candidate before it goes first, and how many at once.
  PICK_MIN_WATCHERS: z.coerce.number().int().positive().default(3),
  PICK_MAX: z.coerce.number().int().nonnegative().default(3),
  /** Live slots: the workflow's `discovery.maxLiveTrends` (a test keeps them equal). */
  MAX_LIVE_TRENDS: z.coerce.number().int().positive().default(24),
  /** Rotation (rotation.ts): a full board swaps a faded trend for a stronger approved candidate. */
  ROTATION: z.enum(["on", "off"]).default("on"),
  ROTATION_MIN_AGE_SEC: z.coerce.number().int().positive().default(36 * 3600),
  ROTATION_FADE_RATIO: z.coerce.number().gt(0).lt(1).default(0.6),
  ROTATION_TIMEOUT_SEC: z.coerce.number().int().positive().default(6 * 3600),
  ROTATION_LIST_GRACE_SEC: z.coerce.number().int().positive().default(20 * 60),
  // The registry's stale_retire_window (6 h on testnet).
  ROTATION_STALE_WINDOW_SEC: z.coerce.number().int().positive().default(6 * 3600),
  ROTATION_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(3600),
  /** Web Push (VAPID). Generate with: bunx web-push generate-vapid-keys. Subject: a mailto: or https: contact. */
  VAPID_PUBLIC_KEY: optional(z.string().min(80)),
  VAPID_PRIVATE_KEY: optional(z.string().min(40)),
  VAPID_SUBJECT: optional(z.string().regex(/^(mailto:|https:\/\/)/)),
  /**
   * Signs the activation tickets the relayer requires before it pays for a new account (the
   * relayer's ACTIVATION_TICKET_SIGNER is this key's public key). Without it the API issues none.
   */
  ACTIVATION_TICKET_KEY: optional(ed25519Secret),
  /** Sign-up caps: tickets per client address per hour and per day, and for everyone per hour and per day. */
  ACTIVATION_TICKETS_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(3),
  ACTIVATION_TICKETS_PER_IP_PER_DAY: z.coerce.number().int().positive().default(10),
  ACTIVATION_TICKETS_PER_HOUR: z.coerce.number().int().positive().default(30),
  ACTIVATION_TICKETS_PER_DAY: z.coerce.number().int().positive().default(150),
  /**
   * Services the public status view checks: name=url pairs, comma-separated. Each may carry
   * |-separated flags for the admin system view: `optional` (its outage is a warning, not
   * critical) and `staleMin=<minutes>` (stalled after that long without work).
   */
  STATUS_SERVICES: z.string().default(""),
  /** Services only the admin system view checks, on top of STATUS_SERVICES (internal ones the public view must not name), with the same flags. */
  ADMIN_SERVICES: z.string().default(""),
  /** The oracle counts as stale after this long without a run or a trend update. */
  ORACLE_STALE_SEC: z.coerce.number().int().positive().default(900),
  /**
   * x402 pay-per-call API (x402/): the account paid (the deployment's treasury when unset) and the
   * price per call in USDC atomic units (6 decimals): full index history, and a rule backtest.
   */
  X402_PAYEE: optional(accountId),
  /**
   * The secret paid signals' weekly viewing keys derive from (64 hex characters); Autopilot holds the
   * same one to copy them. Signals are off without it (backend/src/signals).
   */
  SIGNALS_SECRET: optional(z.string().regex(/^[0-9a-f]{64}$/, "64 hex characters")),
  X402_PRICE: z.coerce.bigint().positive().default(10_000n),
  X402_BACKTEST_PRICE: z.coerce.bigint().positive().default(20_000n),
  /**
   * The relayer that submits payers' signed transfers and pays their gas, with a full-access key
   * nothing else signs with (so nonces never collide). The paid routes are off without it.
   */
  X402_RELAYER_ACCOUNT: optional(accountId),
  X402_RELAYER_KEY: optional(ed25519Secret),
  /** Turn the background loops off (tests, one-off scripts). */
  BACKGROUND: z.enum(["on", "off"]).default("on"),
});

export type Config = z.infer<typeof schema> & {
  deployment: Deployment;
  rpc: RpcEndpoint[];
  frontendOrigins: string[];
  landingOrigins: string[];
  /** What the admin system view probes: STATUS_SERVICES, then ADMIN_SERVICES, the first entry of each name winning. */
  systemServices: ServiceProbe[];
};

export const GLOBAL_PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const global = GLOBAL_PROXY_VARS.filter((v) => (env[v] ?? "").trim() !== "");
  if (global.length > 0) throw new Error(`${global.join(", ")} must be unset: proxies serve Elfa only, set per key in ELFA_PROXIES`);
  const parsed = schema.parse(env);
  if (parsed.ELFA_PROXIES.length > 0 && new URL(parsed.ELFA_API_BASE).hostname !== "api.elfa.ai") {
    throw new Error("ELFA_PROXIES carry requests to api.elfa.ai only; ELFA_API_BASE must point there");
  }
  const deployment = parsed.DEPLOYMENT_JSON ? (JSON.parse(parsed.DEPLOYMENT_JSON) as Deployment) : deploymentOf(parsed.NEAR_NETWORK);
  // #mainnet: the relayer creates accounts only with a ticket from this API, so without the key nobody could sign up.
  if (parsed.NEAR_NETWORK === "mainnet" && !parsed.ACTIVATION_TICKET_KEY) throw new Error("mainnet needs ACTIVATION_TICKET_KEY: the relayer creates accounts only with an activation ticket");
  const rpc = rpcEndpoints(parsed.NEAR_NETWORK, list(parsed.NEAR_RPC_URLS), list(parsed.FASTNEAR_API_KEYS));
  for (const a of parsed.ADMIN_ACCOUNTS) accountId.parse(a);
  const systemServices = [...parseServices(parsed.STATUS_SERVICES), ...parseServices(parsed.ADMIN_SERVICES)].filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i);
  return { ...parsed, deployment, rpc, frontendOrigins: list(parsed.FRONTEND_URL), landingOrigins: list(parsed.LANDING_URL), systemServices };
}
