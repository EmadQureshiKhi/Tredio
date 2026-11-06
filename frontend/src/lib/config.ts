import { type Deployment, deployment, explorerAccount, explorerTx as nearblocksTx, type Network } from "@tredio/contracts";

/** Network and service settings, from the environment at build time. */

export const NETWORK: Network = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const IS_MAINNET = NETWORK === "mainnet";

const url = (value: string | undefined, fallback: string) => (value && value.trim() ? value.trim() : fallback).replace(/\/$/, "");

/** Tredio's API (backend). */
export const BACKEND_URL = url(process.env.NEXT_PUBLIC_API_URL, "http://localhost:4000");
/** The relayer that pays for passkey accounts, owner requests and session gas. */
export const RELAYER_URL = url(process.env.NEXT_PUBLIC_RELAYER_URL, "http://localhost:4100");
export const APP_URL = url(process.env.NEXT_PUBLIC_APP_URL, "http://localhost:3000");

/** The contracts on this network (deployments/<network>.json). */
export const DEPLOYMENT: Deployment = deployment(NETWORK);

/**
 * Read and send endpoints, tried in order: a rate-limited or failing one hands over to the next.
 * NEXT_PUBLIC_NEAR_RPC_URLS (comma-separated) overrides them.
 */
const DEFAULT_RPC_URLS: Record<Network, string[]> = {
  // Intear's endpoint is slower but sends CORS headers and takes bursts the others refuse; dRPC replaces rpc.testnet.near.org, which is deprecated.
  testnet: [DEPLOYMENT.rpc, "https://testnet-rpc.intea.rs", "https://near-testnet.drpc.org"],
  // #mainnet: the same three providers (rpc.mainnet.near.org is deprecated and slow, Lava's endpoint is discontinued).
  mainnet: [DEPLOYMENT.rpc, "https://rpc.intea.rs", "https://near.drpc.org"],
};
const listOf = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const configuredRpcs = listOf(process.env.NEXT_PUBLIC_NEAR_RPC_URLS);
/**
 * FastNEAR browser keys (NEXT_PUBLIC_FASTNEAR_KEYS): keys made for browsers in FastNEAR's
 * dashboard, locked to this app's origins, so shipping them in the bundle is safe. They lead,
 * each visitor starting on a random one so visitors spread across them; the public endpoints follow.
 */
const FASTNEAR_RPC: Record<Network, string> = { testnet: "https://rpc.testnet.fastnear.com", mainnet: "https://rpc.mainnet.fastnear.com" };
const keyedRpcs = listOf(process.env.NEXT_PUBLIC_FASTNEAR_KEYS)
  .map((key) => ({ key, at: Math.random() }))
  .sort((a, b) => a.at - b.at)
  .map(({ key }) => `${FASTNEAR_RPC[NETWORK]}?apiKey=${encodeURIComponent(key)}`);
export const RPC_URLS: readonly string[] = [...new Set([...keyedRpcs, ...(configuredRpcs.length > 0 ? configuredRpcs : DEFAULT_RPC_URLS[NETWORK])])];

/** NearBlocks, where every Tredio contract and account can be read. */
export const EXPLORER_NAME = "NearBlocks";
export const explorerTx = (hash: string) => nearblocksTx(NETWORK, hash);
export const explorerAddress = (account: string) => explorerAccount(NETWORK, account);

/** USDC and outcome tokens carry 6 decimals; trend coins 18. */
export const USDC_DECIMALS = 6;
export const COIN_DECIMALS = 18;

/** The NEP-413 recipient every Tredio sign-in names (backend/src/api/user-auth.ts). */
export const SIGN_IN_RECIPIENT = "tredio.bid";

/** Hyperliquid's network for this deployment: testnet accounts trade Hyperliquid testnet. */
export const HL_NETWORK: Network = NETWORK;

/** NEAR AI Cloud's verifier, where a listing's signed review evidence can be checked. */
export const NEAR_AI_VERIFY_URL = "https://cloud.near.ai/verify";
