import { type RpcEndpoint, rpcEndpoints } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4900),
  NEAR_NETWORK: z.literal("testnet").default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  FASTNEAR_API_KEYS: optional(z.string()),
  /** Tredio's API: live trends, holdings, threads, and where calls and posts go. */
  BACKEND_URL: z.string().url().default("http://localhost:4000").transform((u) => u.replace(/\/+$/, "")),
  /** The personas (scripts/activity-setup.ts writes it): their accounts, session keys and caller keys. */
  PERSONAS_FILE: z.string().default("activity-personas.json"),
  /** Tops up the personas' session gas keys. */
  FUNDER_ACCOUNT_ID: z.string().min(2),
  FUNDER_PRIVATE_KEY: z.string().regex(/^ed25519:/),
  /** The last UTC day the personas act (YYYY-MM-DD); after it the service only answers its health. */
  ACTIVITY_UNTIL: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Actions across all personas a day, spread over their waking hours. */
  ACTIONS_PER_DAY: z.coerce.number().int().positive().default(120),
  /** A session gas key below this is topped up by GAS_KEY_TOPUP_NEAR before its persona sends. */
  GAS_KEY_MIN_NEAR: z.coerce.number().positive().default(0.25),
  GAS_KEY_TOPUP_NEAR: z.coerce.number().positive().default(0.3),
});

export type Config = z.infer<typeof schema> & { deployment: Deployment; rpc: RpcEndpoint[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  return { ...c, deployment: deploymentOf(c.NEAR_NETWORK), rpc: rpcEndpoints(c.NEAR_NETWORK, list(c.NEAR_RPC_URLS), list(c.FASTNEAR_API_KEYS)) };
}
