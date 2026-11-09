import { type RpcEndpoint, rpcEndpoints } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const url = z.string().url().transform((u) => u.replace(/\/+$/, ""));
const onOff = z.enum(["on", "off"]);

/** A USDC amount as the market writes prices ("0.05", "12.00"): at most 6 decimals. */
export const usdcAmount = z.string().regex(/^\d+(\.\d{1,6})?$/, "a decimal USDC amount with at most 6 decimals, for example 0.05");

/** An agent API token as the market mints them: `aat_` and 32 hex characters. */
export const AGENT_TOKEN = /^aat_[0-9a-f]{32}$/;

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4800),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  /** FastNEAR API keys (comma-separated): requests take them in turn, ahead of the public providers. */
  FASTNEAR_API_KEYS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  /** Tredio's API, where topics resolve and the evidence comes from. */
  BACKEND_URL: url.default("http://localhost:4000"),
  /** The API as callers reach it, for the verification links in a result (BACKEND_URL when unset). */
  PUBLIC_API_URL: optional(url),
  /** The app, for the trend page link in a result. */
  APP_URL: url.default("https://app.tredio.bid"),
  /** Find the oracle report behind the newest checkpoint and check its signature (FastNEAR's transactions API). */
  VERIFY_ORACLE_REPORT: onOff.default("on"),
  /** The transactions API; FastNEAR's for the network when unset. */
  NEAR_TX_API_URL: optional(url),
  /** The marketplace and this agent's API token (minted by the agent's owner, or returned once by self-registration). */
  MARKET_URL: url.default("https://market.near.ai"),
  MARKET_API_TOKEN: z.string().regex(AGENT_TOKEN, "MARKET_API_TOKEN is the agent's aat_ token (aat_ and 32 hex characters)"),
  /** The webhook secret set on the listing (32 characters or more); unset, the worker only polls. */
  MARKET_WEBHOOK_SECRET: optional(z.string().min(32, "the market asks for a webhook secret of at least 32 characters")),
  /** How often the assignments are polled (the market asks for 30 to 60 s; webhooks make it a reconciliation). */
  POLL_INTERVAL_SEC: z.coerce.number().int().min(5).max(300).default(15),
  /** This agent's price per call, in USDC; a hire holding less is declined. */
  PRICE_USDC: usdcAmount.default("0.05"),
  /** Escrow tokens a hire may hold: plans are priced in USD and A2A calls paid 1:1 in USDC, and the docs show both on assignments. */
  ACCEPT_TOKENS: z.string().default("USDC,USD"),
  /** Calls accepted per UTC day, paid and free test runs together; past it a hire is declined and the caller pays nothing. */
  DAILY_CAP: z.coerce.number().int().min(1).max(100_000).default(200),
  /** Free test runs (a hire holding no escrow, which only the agent's owner or an admin can start) per UTC day. */
  FREE_TESTS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(5),
  /** Assignments worked at once. */
  MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(4),
  /** Tries for one assignment before it is declined as failed (the caller is not charged). */
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /** The time one answer may take, oracle report search included. */
  WORK_TIMEOUT_SEC: z.coerce.number().int().min(5).max(600).default(45),
});

export type Config = z.infer<typeof schema> & {
  deployment: Deployment;
  rpc: RpcEndpoint[];
  publicApiUrl: string;
  txApiUrl: string;
  price: bigint;
  acceptTokens: string[];
};

/** USDC amounts in micro units (6 decimals): `"0.05"` is 50000n. Extra decimals are cut, never rounded up. */
export function microUsdc(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`not a decimal amount: ${amount}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

/** Micro USDC as the market writes amounts: `50000n` is `"0.05"` (two decimals at least). */
export function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  const rpc = rpcEndpoints(c.NEAR_NETWORK, list(c.NEAR_RPC_URLS), list(c.FASTNEAR_API_KEYS));
  const price = microUsdc(c.PRICE_USDC);
  if (price <= 0n) throw new Error("PRICE_USDC must be above 0");
  return {
    ...c,
    deployment,
    rpc,
    publicApiUrl: c.PUBLIC_API_URL ?? c.BACKEND_URL,
    txApiUrl: c.NEAR_TX_API_URL ?? `https://tx.${c.NEAR_NETWORK === "mainnet" ? "main" : "test"}.fastnear.com`,
    price,
    acceptTokens: list(c.ACCEPT_TOKENS).map((t) => t.toUpperCase()),
  };
}
