import { z } from "zod";

/** Empty values count as unset, so `.env` files can keep every key. */
const opt = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());
const int = (def: number, min = 0) => z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(min).default(def));

const Env = z.object({
  NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  INDEXER_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, "INDEXER_SCHEMA must be a plain lowercase identifier").default("indexer"),
  START_BLOCK: opt(z.coerce.number().int().positive()),
  NEARDATA_URL: opt(z.string().url()),
  NEARDATA_API_KEY: opt(z.string().min(1)),
  NEARDATA_RPM: opt(z.coerce.number().int().min(1)),
  NEARDATA_CONCURRENCY: int(3, 1),
  DEPLOYMENTS_FILE: opt(z.string().min(1)),
  PORT: int(4600, 1),
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

export type Config = Omit<z.infer<typeof Env>, "NEARDATA_RPM"> & { NEARDATA_RPM: number; neardataUrl: string };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  return {
    ...c,
    NEARDATA_RPM: c.NEARDATA_RPM ?? (c.NEARDATA_API_KEY ? KEY_RPM : FREE_RPM),
    neardataUrl: (c.NEARDATA_URL ?? `https://${c.NETWORK}.neardata.xyz`).replace(/\/+$/, ""),
  };
}
