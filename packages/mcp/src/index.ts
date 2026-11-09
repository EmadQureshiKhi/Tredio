import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rpcEndpoints, Viewer } from "@tredio/chain";
import { deployment as deploymentOf, toRaw, USDC_DECIMALS } from "@tredio/contracts";
import { TredioApi } from "./api";
import { FastNearTxIndex } from "./chain";
import { NO_POLICY, parsePolicy, type Policy, SpendGuard, SpendLedger } from "./policy";
import { createServer } from "./server";
import { accountSigner, callerKey, sessionSigner } from "./signers";
import type { TradingDeps } from "./trade";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

export { ApiError, TredioApi } from "./api";
export { type ChainViews, FastNearTxIndex, type IndexedTx, type TxIndex } from "./chain";
export { isSpendingTool, type LedgerEntry, NO_POLICY, parsePolicy, type Policy, type PolicyCheck, PolicyRefusal, policyJson, SpendGuard, SpendLedger, SPENDING_TOOLS, TRADE_TOOLS, type TradeTool } from "./policy";
export { acceptableIndex, anchoredLimit, perpPreview, quoteBuy, quoteSell } from "./quote";
export { createServer, SERVER_NAME, SERVER_VERSION, type ServerDeps } from "./server";
export { accountSigner, type CallerKey, callerKey, type Signer, sessionSigner, type TxOutcome } from "./signers";
export { eventsOf, refusalOf, registerTradeTools, type TradingDeps } from "./trade";
export { checkReview, checkReviewBodies, ed25519SignatureValid, recoverSigner, reportSignatureValid, type ReviewBodies, type ReviewBodiesCheck, type ReviewCheck, type ReviewEvidence, reviewHashOf, verifyIndex } from "./verify";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** The trading policy from `TREDIO_POLICY` (JSON) or the file `TREDIO_POLICY_FILE`; none allows nothing. */
function policyFromEnv(env: Record<string, string | undefined>): { policy: Policy; dir: string | null } {
  const inline = env.TREDIO_POLICY?.trim();
  const file = env.TREDIO_POLICY_FILE?.trim();
  if (inline && file) throw new Error("set TREDIO_POLICY or TREDIO_POLICY_FILE, not both");
  if (!inline && !file) return { policy: NO_POLICY, dir: null };
  let text = inline ?? "";
  if (file) {
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`could not read the trading policy ${file}: ${String((e as Error).message ?? e)}`);
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`the trading policy${file ? ` ${file}` : ""} is not valid JSON`);
  }
  return { policy: parsePolicy(json), dir: file ? dirname(resolve(file)) : null };
}

/** Trading from env, or null when no key is configured (see serverFromEnv). */
export function tradingFromEnv(env: Record<string, string | undefined>, network: "testnet" | "mainnet", rpc: ReturnType<typeof rpcEndpoints>, viewer: Viewer): TradingDeps | null {
  const pair = (a: string, k: string) => {
    const account = env[a]?.trim().toLowerCase();
    const key = env[k]?.trim();
    if (Boolean(account) !== Boolean(key)) throw new Error(`set both ${a} and ${k}, or neither`);
    if (account && !ACCOUNT_ID.test(account)) throw new Error(`${a} is not a NEAR account id`);
    return account && key ? { account, key } : null;
  };
  const trader = pair("TREDIO_TRADER_ACCOUNT", "TREDIO_TRADER_PRIVATE_KEY");
  const session = pair("TREDIO_SESSION_ACCOUNT", "TREDIO_SESSION_KEY");
  if (trader && session) throw new Error("set one trading key: TREDIO_TRADER_ACCOUNT (a NEAR account's own key) or TREDIO_SESSION_ACCOUNT (a passkey account's session key)");
  const callerSecret = env.TREDIO_CALLER_KEY?.trim() || trader?.key;
  const { policy, dir } = policyFromEnv(env);
  if (!trader && !session && !callerSecret) {
    if (policy !== NO_POLICY) throw new Error("a trading policy is set but no key to trade with: set TREDIO_TRADER_ACCOUNT and TREDIO_TRADER_PRIVATE_KEY, or TREDIO_SESSION_ACCOUNT and TREDIO_SESSION_KEY");
    return null;
  }
  // #mainnet: the same tools trade mainnet once deployments/mainnet.json is live; the policy is what keeps them in bounds.
  const signer = trader
    ? accountSigner({ network, account: trader.account, privateKey: trader.key, rpc })
    : session
      ? sessionSigner({ network, account: session.account, sessionKey: session.key, rpc, gasKey: (a, k) => viewer.gasKey(a, k) })
      : null;
  const named = env.TREDIO_LEDGER_FILE?.trim() || policy.ledgerFile;
  const ledgerFile = named ? (isAbsolute(named) ? named : resolve(dir ?? process.cwd(), named)) : join(homedir(), ".tredio-mcp", `ledger-${network}.json`);
  return {
    signer,
    caller: callerSecret ? callerKey(callerSecret) : null,
    guard: new SpendGuard(policy, new SpendLedger(ledgerFile)),
    relayerUrl: env.TREDIO_RELAYER_URL?.trim() || null,
  };
}

/**
 * The server as `tredio-mcp` runs it, configured from env:
 * - `TREDIO_API_URL` (default http://localhost:4000), `NEAR_NETWORK` (testnet), `NEAR_RPC_URLS`
 *   (comma-separated; FastNEAR and NEAR's own by default), `FASTNEAR_API_KEYS` (comma-separated,
 *   taken in turn ahead of those), `NEAR_TX_API_URL` (FastNEAR's transactions API, to find oracle
 *   reports).
 * - Optional x402 purchases: `TREDIO_X402_ACCOUNT` and `TREDIO_X402_PRIVATE_KEY` (a full-access
 *   key), at most `TREDIO_X402_MAX_USDC` (default 0.05) per call.
 * - Optional trading, one key: `TREDIO_TRADER_ACCOUNT` and `TREDIO_TRADER_PRIVATE_KEY` (a NEAR
 *   account's full-access key), or `TREDIO_SESSION_ACCOUNT` and `TREDIO_SESSION_KEY` (a passkey
 *   account's session key); `TREDIO_CALLER_KEY` (an ed25519 key for calls; the trader's key by
 *   default); the policy in `TREDIO_POLICY` (JSON) or `TREDIO_POLICY_FILE`, the ledger at
 *   `TREDIO_LEDGER_FILE` (default ~/.tredio-mcp/ledger-<network>.json), and `TREDIO_RELAYER_URL`
 *   for a session's gas and storage refills.
 */
export function serverFromEnv(env: Record<string, string | undefined>): McpServer {
  const network = env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  if (env.NEAR_NETWORK && env.NEAR_NETWORK !== network) throw new Error("NEAR_NETWORK is testnet or mainnet");
  const rpc = rpcEndpoints(network, list(env.NEAR_RPC_URLS), list(env.FASTNEAR_API_KEYS));
  const viewer = new Viewer(network, rpc);
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
    trading: tradingFromEnv(env, network, rpc, viewer),
  });
}
