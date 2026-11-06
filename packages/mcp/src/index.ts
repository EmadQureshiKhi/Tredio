import { DEFAULT_RPCS, Viewer } from "@tredio/chain";
import { deployment as deploymentOf, toRaw, USDC_DECIMALS } from "@tredio/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TredioApi } from "./api";
import { FastNearTxIndex } from "./chain";
import { createServer } from "./server";

export { ApiError, TredioApi } from "./api";
export { type ChainViews, FastNearTxIndex, type IndexedTx, type TxIndex } from "./chain";
export { createServer, SERVER_NAME, SERVER_VERSION, type ServerDeps } from "./server";
export { checkReview, checkReviewBodies, ed25519SignatureValid, recoverSigner, reportSignatureValid, type ReviewBodies, type ReviewBodiesCheck, type ReviewCheck, type ReviewEvidence, reviewHashOf, verifyIndex } from "./verify";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * The server as `tredio-mcp` runs it, configured from env:
 * - `TREDIO_API_URL` (default http://localhost:4000), `NEAR_NETWORK` (testnet), `NEAR_RPC_URLS`
 *   (comma-separated; FastNEAR and NEAR's own by default), `NEAR_TX_API_URL` (FastNEAR's
 *   transactions API, to find oracle reports).
 * - Optional x402 purchases: `TREDIO_X402_ACCOUNT` and `TREDIO_X402_PRIVATE_KEY` (a full-access
 *   key), at most `TREDIO_X402_MAX_USDC` (default 0.05) per call.
 */
export function serverFromEnv(env: Record<string, string | undefined>): McpServer {
  const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  if (env.NEAR_NETWORK && env.NEAR_NETWORK !== network) throw new Error("NEAR_NETWORK is testnet or mainnet");
  const rpcUrls = list(env.NEAR_RPC_URLS).length > 0 ? list(env.NEAR_RPC_URLS) : DEFAULT_RPCS[network];
  const viewer = new Viewer(network, rpcUrls);
  const txApi = env.NEAR_TX_API_URL || `https://tx.${network === "mainnet" ? "main" : "test"}.fastnear.com`;
  const account = env.TREDIO_X402_ACCOUNT?.trim();
  const key = env.TREDIO_X402_PRIVATE_KEY?.trim();
  if (Boolean(account) !== Boolean(key)) throw new Error("set both TREDIO_X402_ACCOUNT and TREDIO_X402_PRIVATE_KEY, or neither");
  return createServer({
    api: new TredioApi(env.TREDIO_API_URL || "http://localhost:4000"),
    chain: viewer,
    txIndex: new FastNearTxIndex(txApi),
    deployment: deploymentOf(network),
    network,
    x402: account && key ? { signer: { accountId: account, privateKey: key }, rpc: viewer, maxAmount: toRaw(env.TREDIO_X402_MAX_USDC || "0.05", USDC_DECIMALS) } : null,
  });
}
