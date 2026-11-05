import { DEFAULT_RPCS } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4600),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  /** The account that submits reports (it pays gas; the signature is what the registry trusts). */
  ORACLE_ACCOUNT_ID: z.string().min(2),
  ORACLE_PRIVATE_KEY: z.string().regex(/^ed25519:/),
  /** The report signing key the registry trusts (`set_oracle`), held by this process in local-key mode. */
  REPORT_SIGNING_KEY: z.string().regex(/^ed25519:/),
  BACKEND_URL: z.string().url().default("http://localhost:4000"),
  /** The backend's ORACLE_TOKEN. */
  BACKEND_TOKEN: z.string().min(16),
  RUN_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  MAX_SAMPLES_PER_RUN: z.coerce.number().int().positive().default(24),
  MAX_CANDIDATES_PER_RUN: z.coerce.number().int().min(0).default(2),
  /** Live slots: equal to the backend's MAX_LIVE_TRENDS. */
  MAX_LIVE_TRENDS: z.coerce.number().int().positive().default(24),
  HEARTBEAT_SEC: z.coerce.number().int().positive().default(420),
  DEVIATION_BPS: z.coerce.number().int().positive().default(100),
  MIN_CREATE_INDEX_POINTS: z.coerce.number().nonnegative().default(5),
  /** Hyperliquid marks every report carries, for the account contract's order guard. */
  MARK_ASSETS: z.string().default("BTC,ETH,SOL,NEAR,HYPE").transform((v) => list(v).map((s) => s.toUpperCase())),
  MIN_BALANCE_NEAR: z.coerce.number().nonnegative().default(2),
});

export type Config = z.infer<typeof schema> & { deployment: Deployment; rpcUrls: string[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  const rpcUrls = list(c.NEAR_RPC_URLS).length > 0 ? list(c.NEAR_RPC_URLS) : DEFAULT_RPCS[c.NEAR_NETWORK];
  return { ...c, deployment, rpcUrls };
}
