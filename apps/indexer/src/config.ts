import { z } from "zod";

/** Empty values count as unset, so `.env` files can keep every key. */
const opt = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());
const int = (def: number, min = 0) => z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(min).default(def));

const Env = z.object({
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** `txs`: FastNEAR's transactions API (no key needed); `blocks`: neardata, every block. */
  INDEXER_SOURCE: z.enum(["txs", "blocks"]).default("txs"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  INDEXER_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, "INDEXER_SCHEMA must be a plain lowercase identifier").default("indexer"),
  START_BLOCK: opt(z.coerce.number().int().positive()),
  NEARDATA_URL: opt(z.string().url()),
  NEARDATA_API_KEY: opt(z.string().min(1)),
  NEARDATA_RPM: opt(z.coerce.number().int().min(1)),
  NEARDATA_CONCURRENCY: int(3, 1),
  TX_API_URL: opt(z.string().url()),
  TX_API_KEY: opt(z.string().min(1)),
  TX_API_RPM: opt(z.coerce.number().int().min(1)),
  /** FastNEAR API keys (comma-separated) for both feeds, taken in turn; NEARDATA_API_KEY or TX_API_KEY wins for its feed. */
  FASTNEAR_API_KEYS: opt(z.string()),
  /** Accounts that relay owner requests (comma-separated), listed like the contracts. */
  RELAYER_ACCOUNT_ID: opt(z.string().min(2)),
  TX_SAFETY_BLOCKS: int(10, 0),
  TX_LOOKBACK_BLOCKS: int(600, 0),
  TX_BACKFILL_WINDOW: int(100_000, 1),
  TX_SLOW_PER_CYCLE: int(2, 0),
  TX_POLL_MS: int(3000, 100),
  TX_PENDING_MAX_BLOCKS: int(3000, 10),
  DEPLOYMENTS_FILE: opt(z.string().min(1)),
  PORT: int(4700, 1),
  MAX_LAG_SEC: int(60, 1),
  POLL_MS: int(1000, 100),
  LIVE_TIMEOUT_SEC: int(300, 10),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/**
 * Requests a minute without an API key: FastNEAR answers 429 past about 30 a minute per IP
 * (measured 2026-11-05, though its docs say 180). With a key the default is a starting point for
 * the subscription's limit; a 429 pauses requests either way.
 */
export const FREE_RPM = 28;
export const KEY_RPM = 600;
/** The transactions API answers 429 past about 60 requests a minute per IP without a key (measured 2026-11-06). */
export const TX_FREE_RPM = 55;

/** The relayer the deploy scripts create, per network. */
const DEFAULT_RELAYERS: Record<string, string> = { testnet: "tredio-relayer.testnet" };

export type Config = Omit<z.infer<typeof Env>, "NEARDATA_RPM" | "TX_API_RPM" | "RELAYER_ACCOUNT_ID" | "FASTNEAR_API_KEYS"> & {
  NEARDATA_RPM: number;
  TX_API_RPM: number;
  neardataKeys: string[];
  txApiKeys: string[];
  neardataUrl: string;
  txApiUrl: string;
  relayers: string[];
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const { RELAYER_ACCOUNT_ID, FASTNEAR_API_KEYS, ...rest } = c;
  const shared = [...new Set((FASTNEAR_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean))];
  const neardataKeys = c.NEARDATA_API_KEY ? [c.NEARDATA_API_KEY] : shared;
  const txApiKeys = c.TX_API_KEY ? [c.TX_API_KEY] : shared;
  return {
    ...rest,
    // Each key brings its own allowance, so the default rate grows with the number of keys.
    NEARDATA_RPM: c.NEARDATA_RPM ?? (neardataKeys.length > 0 ? KEY_RPM * neardataKeys.length : FREE_RPM),
    TX_API_RPM: c.TX_API_RPM ?? (txApiKeys.length > 0 ? KEY_RPM * txApiKeys.length : TX_FREE_RPM),
    neardataKeys,
    txApiKeys,
    neardataUrl: (c.NEARDATA_URL ?? `https://${c.NEAR_NETWORK}.neardata.xyz`).replace(/\/+$/, ""),
    txApiUrl: (c.TX_API_URL ?? `https://tx.${c.NEAR_NETWORK === "mainnet" ? "main" : "test"}.fastnear.com`).replace(/\/+$/, ""),
    relayers: (RELAYER_ACCOUNT_ID ?? DEFAULT_RELAYERS[c.NEAR_NETWORK] ?? "").split(",").map((a) => a.trim()).filter(Boolean),
  };
}
