import { type RpcEndpoint, rpcEndpoints } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const near = (v: string) => BigInt(Math.round(Number(v) * 1e6)) * 10n ** 18n;
const nearAmount = z.string().regex(/^\d+(\.\d{1,6})?$/).transform(near);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4100),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  /** FastNEAR API keys (comma-separated): requests take them in turn, ahead of the public providers. */
  FASTNEAR_API_KEYS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  /** The account that pays, and its key (`ed25519:<base58>`). */
  RELAYER_ACCOUNT_ID: z.string().min(2),
  RELAYER_PRIVATE_KEY: z.string().regex(/^ed25519:/),
  /** The key is a gas key with this many nonce lanes (0: a regular key, one transaction at a time). */
  RELAYER_GAS_KEY_LANES: z.coerce.number().int().min(0).max(16).default(0),
  /**
   * The backend's activation ticket key (`ed25519:<base58>` public key). With it the relayer
   * creates only accounts the API vouched for; mainnet refuses to start without it.
   */
  ACTIVATION_TICKET_SIGNER: optional(z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/)),
  /** NEAR a new account receives: storage, registrations and its first session's gas allowance. */
  CREATE_DEPOSIT_NEAR: nearAmount.default(near("0.4")),
  /** A session gas key is topped up to this when it falls below SESSION_GAS_MIN_NEAR. */
  SESSION_GAS_TARGET_NEAR: nearAmount.default(near("0.35")),
  SESSION_GAS_MIN_NEAR: nearAmount.default(near("0.31")),
  /** Before a session key is added, the account's NEAR beyond storage is topped up to the target when below the minimum (a gas key needs about 0.12). */
  SESSION_STORAGE_MIN_NEAR: nearAmount.default(near("0.15")),
  SESSION_STORAGE_TARGET_NEAR: nearAmount.default(near("0.2")),
  /** Below this balance the relayer reports itself unhealthy (the top-up service refills it). */
  MIN_BALANCE_NEAR: nearAmount.default(near("2")),
  /** Budgets (in memory, reset on restart). */
  ACCOUNTS_PER_HOUR: z.coerce.number().int().positive().default(30),
  ACCOUNTS_PER_DAY: z.coerce.number().int().positive().default(150),
  OWNER_CALLS_PER_ACCOUNT_PER_HOUR: z.coerce.number().int().positive().default(30),
  TOPUPS_PER_SESSION_PER_DAY: z.coerce.number().int().positive().default(3),
  TOPUPS_PER_ACCOUNT_PER_DAY: z.coerce.number().int().positive().default(12),
  STORAGE_TOPUPS_PER_ACCOUNT_PER_DAY: z.coerce.number().int().positive().default(4),
  META_TX_PER_ACCOUNT_PER_HOUR: z.coerce.number().int().positive().default(120),
  /** NEAR spent on gas and deposits per hour, across everything, before the relayer pauses. */
  NEAR_PER_HOUR: nearAmount.default(near("15")),
  /** Comma-separated app origins allowed by CORS. */
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

export type Config = z.infer<typeof schema> & { deployment: Deployment; rpc: RpcEndpoint[]; origins: string[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  if (c.NEAR_NETWORK === "mainnet" && !c.ACTIVATION_TICKET_SIGNER) throw new Error("ACTIVATION_TICKET_SIGNER is required on mainnet");
  const rpc = rpcEndpoints(c.NEAR_NETWORK, list(c.NEAR_RPC_URLS), list(c.FASTNEAR_API_KEYS));
  return { ...c, deployment, rpc, origins: list(c.FRONTEND_URL) };
}
