import { DEFAULT_RPCS } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4200),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  KEEPER_ACCOUNT_ID: z.string().min(2),
  KEEPER_PRIVATE_KEY: z.string().regex(/^ed25519:/),
  /** The key is a gas key with this many nonce lanes (0: a regular key, one transaction at a time). */
  KEEPER_GAS_KEY_LANES: z.coerce.number().int().min(0).max(16).default(0),
  /** Series windows to open, in seconds (24 h and 7 d; testnet also runs its short test window). */
  SERIES_WINDOWS: z.string().default("86400,604800").transform((v) => list(v).map(Number)),
  /** Create a trend coin for every active trend. */
  COINS: z.enum(["on", "off"]).default("on"),
  SETTLE_DELAY_SEC: z.coerce.number().int().min(0).default(30),
  SCAN_INTERVAL_SEC: z.coerce.number().int().positive().default(15),
  MAX_ACTIONS_PER_SCAN: z.coerce.number().int().positive().default(12),
  /** A live trend counts as stale (an alert) after this long without an oracle update. */
  STALE_ALERT_SEC: z.coerce.number().int().positive().default(900),
  /** The backend's rotation endpoint: trends rotating out go stale on purpose. */
  ROTATION_URL: optional(z.string().url()),
  MIN_BALANCE_NEAR: z.coerce.number().positive().default(1),
});

export type Config = z.infer<typeof schema> & { deployment: Deployment; rpcUrls: string[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  const rpcUrls = list(c.NEAR_RPC_URLS).length > 0 ? list(c.NEAR_RPC_URLS) : DEFAULT_RPCS[c.NEAR_NETWORK];
  return { ...c, deployment, rpcUrls };
}
