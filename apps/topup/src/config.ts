import { type RpcEndpoint, rpcEndpoints } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";
import { NEAR, parseTargets, type Target, USDC } from "./targets";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const near = (fallback: number) => z.coerce.number().nonnegative().default(fallback).transform((v) => (BigInt(Math.round(v * 1e6)) * NEAR) / 1_000_000n);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4500),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  /** FastNEAR API keys (comma-separated): requests take them in turn, ahead of the public providers. */
  FASTNEAR_API_KEYS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  TREASURY_ACCOUNT_ID: z.string().min(2),
  TREASURY_PRIVATE_KEY: z.string().regex(/^ed25519:/),
  /** NEAR the treasury never spends below. */
  TREASURY_FLOOR_NEAR: near(2),
  /** Below this the treasury reports itself low: ask for a refill. */
  TREASURY_LOW_NEAR: near(10),
  /** NEAR targets, highest priority first: name=account[/ed25519:key]@min/target. */
  TARGETS: z.string().default(""),
  /** Testnet only: USDC targets (name=account@min/target), minted by the USDC minter account. */
  USDC_TARGETS: z.string().default(""),
  USDC_MINTER_ACCOUNT_ID: optional(z.string().min(2)),
  USDC_MINTER_PRIVATE_KEY: optional(z.string().regex(/^ed25519:/)),
  /** The most one target receives a day. */
  DAILY_CAP_NEAR: near(10),
  DAILY_CAP_USDC: z.coerce.number().nonnegative().default(20_000),
  CHECK_INTERVAL_SEC: z.coerce.number().int().positive().default(120),
  COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(600),
  /** Plan and report, send nothing. */
  DRY_RUN: z.enum(["on", "off"]).default("off"),
  STATE_FILE: z.string().default(".topup-state.json"),
});

export type Config = z.infer<typeof schema> & { deployment: Deployment; rpc: RpcEndpoint[]; targets: Target[]; usdcTargets: Target[]; dailyCapUsdc: bigint };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  const rpc = rpcEndpoints(c.NEAR_NETWORK, list(c.NEAR_RPC_URLS), list(c.FASTNEAR_API_KEYS));
  const usdcTargets = parseTargets(c.USDC_TARGETS, "usdc");
  if (usdcTargets.length > 0 && c.NEAR_NETWORK === "mainnet") throw new Error("USDC_TARGETS are testnet only: mainnet USDC is real money");
  if (usdcTargets.length > 0 && !(c.USDC_MINTER_ACCOUNT_ID && c.USDC_MINTER_PRIVATE_KEY)) throw new Error("USDC_TARGETS need USDC_MINTER_ACCOUNT_ID and USDC_MINTER_PRIVATE_KEY");
  return { ...c, deployment, rpc, targets: parseTargets(c.TARGETS, "near"), usdcTargets, dailyCapUsdc: BigInt(Math.round(c.DAILY_CAP_USDC)) * USDC };
}
