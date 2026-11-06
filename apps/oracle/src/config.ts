import { AUTOPILOT_MARKETS, AUTOPILOT_MARKETS_TEXT } from "@tredio/autopilot";
import { type RpcEndpoint, rpcEndpoints } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4600),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  /** FastNEAR API keys (comma-separated): requests take them in turn, ahead of the public providers. */
  FASTNEAR_API_KEYS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  /** The account that submits reports (it pays gas; the signature is what the registry trusts). */
  ORACLE_ACCOUNT_ID: z.string().min(2),
  ORACLE_PRIVATE_KEY: z.string().regex(/^ed25519:/),
  /**
   * local: this process computes and signs reports with REPORT_SIGNING_KEY (bootstrap).
   * outlayer: the OutLayer enclave build (apps/oracle/tee) computes and signs them; this process
   * only requests the run and submits the signed report.
   */
  ORACLE_MODE: z.enum(["local", "outlayer"]).default("local"),
  /** The report signing key the registry trusts in local mode. */
  REPORT_SIGNING_KEY: optional(z.string().regex(/^ed25519:/)),
  /** OutLayer's contract; defaults to the network's (OUTLAYER_CONTRACTS). */
  OUTLAYER_CONTRACT: optional(z.string().min(2)),
  OUTLAYER_WASM_URL: optional(z.string().url()),
  OUTLAYER_WASM_HASH: optional(z.string().regex(/^[0-9a-f]{64}$/)),
  OUTLAYER_MAX_SECONDS: z.coerce.number().int().min(10).max(180).default(60),
  /** OutLayer secrets holding the enclave's API token: profile and owner account. */
  OUTLAYER_SECRETS_PROFILE: optional(z.string()),
  OUTLAYER_SECRETS_ACCOUNT: optional(z.string()),
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
  /**
   * Hyperliquid marks every report carries, for the account contract's order guard: Autopilot's
   * markets (AUTOPILOT_MARKETS), which it trades only because these are marked, and any others listed.
   */
  MARK_ASSETS: z
    .string()
    .default(AUTOPILOT_MARKETS.join(","))
    .transform((v) => list(v).map((s) => s.toUpperCase()))
    .refine((assets) => AUTOPILOT_MARKETS.every((m) => assets.includes(m)), `MARK_ASSETS must include Autopilot's markets (${AUTOPILOT_MARKETS_TEXT}): their orders wait for these marks`),
  MIN_BALANCE_NEAR: z.coerce.number().nonnegative().default(2),
});

/** OutLayer's contract on each network (both expose `request_execution`, checked 2026-11-07). #mainnet */
export const OUTLAYER_CONTRACTS = { testnet: "outlayer.testnet", mainnet: "outlayer.near" } as const;

export type Config = Omit<z.infer<typeof schema>, "OUTLAYER_CONTRACT"> & { OUTLAYER_CONTRACT: string; deployment: Deployment; rpc: RpcEndpoint[] };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  const rpc = rpcEndpoints(c.NEAR_NETWORK, list(c.NEAR_RPC_URLS), list(c.FASTNEAR_API_KEYS));
  if (c.ORACLE_MODE === "local" && !c.REPORT_SIGNING_KEY) throw new Error("local mode needs REPORT_SIGNING_KEY");
  if (c.ORACLE_MODE === "outlayer" && !(c.OUTLAYER_WASM_URL && c.OUTLAYER_WASM_HASH)) throw new Error("outlayer mode needs OUTLAYER_WASM_URL and OUTLAYER_WASM_HASH");
  return { ...c, OUTLAYER_CONTRACT: c.OUTLAYER_CONTRACT ?? OUTLAYER_CONTRACTS[c.NEAR_NETWORK], deployment, rpc };
}
