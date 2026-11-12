import { type RpcEndpoint, rpcEndpoints } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const price = z.coerce.number().positive().max(0.5);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4300),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  /** FastNEAR API keys (comma-separated): requests take them in turn, ahead of the public providers. */
  FASTNEAR_API_KEYS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  MM_ACCOUNT_ID: z.string().min(2),
  MM_PRIVATE_KEY: z.string().regex(/^ed25519:/),
  MM_GAS_KEY_LANES: z.coerce.number().int().min(0).max(16).default(0),
  /** Series windows to quote (seconds). */
  QUOTE_WINDOWS: z.string().default("86400,604800").transform((v) => list(v).map(Number)),
  /** Series quoted at once, shorter windows first: one 24h series per live slot (the API's MAX_LIVE_TRENDS). */
  MAX_SERIES: z.coerce.number().int().positive().default(24),
  /** Complete sets (USDC) minted per quoted series as ask inventory. */
  SETS_PER_SERIES: z.coerce.number().positive().default(100),
  /** USDC kept on the book to back bids across all series. */
  MARGIN_USDC: z.coerce.number().nonnegative().default(1500),
  HALF_SPREAD: price.default(0.03),
  LEVEL_STEP: price.default(0.01),
  LEVELS: z.coerce.number().int().min(1).max(5).default(2),
  LEVEL_TOKENS: z.coerce.number().positive().default(20),
  MAX_SKEW: price.default(0.03),
  INVENTORY_LIMIT: z.coerce.number().positive().default(60),
  /** Re-quote when a level drifts this many 0.001 ticks; each re-quote is a transaction. */
  REQUOTE_TICKS: z.coerce.number().int().positive().default(15),
  /** Least seconds between drift-only re-quotes of one market; fills and large moves re-quote at once. */
  MIN_REQUOTE_SEC: z.coerce.number().int().nonnegative().default(120),
  STOP_BEFORE_EXPIRY_SEC: z.coerce.number().int().nonnegative().default(300),
  ARB_MIN_EDGE: z.coerce.number().positive().default(0.005),
  ARB_MAX_TOKENS: z.coerce.number().positive().default(200),
  TICK_SEC: z.coerce.number().int().positive().default(20),
  MIN_BALANCE_NEAR: z.coerce.number().nonnegative().default(1),
  /** Any value but empty stops all quoting and pulls every order; so does creating KILL_SWITCH_FILE. */
  KILL_SWITCH: optional(z.string()),
  KILL_SWITCH_FILE: optional(z.string()),
  STATE_FILE: z.string().default(".mm-state.json"),
});

export type Config = z.infer<typeof schema> & { deployment: Deployment; rpc: RpcEndpoint[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  const rpc = rpcEndpoints(c.NEAR_NETWORK, list(c.NEAR_RPC_URLS), list(c.FASTNEAR_API_KEYS));
  return { ...c, deployment, rpc };
}
