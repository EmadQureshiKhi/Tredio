/**
 * One attention check from the command line, without the market: what a hire for `<topic>` would
 * receive. Reads Tredio's API (BACKEND_URL, default http://localhost:4000) and NEAR RPC.
 *
 *   bun scripts/check.ts "World Cup"            # the deliverable (Markdown with the JSON block)
 *   bun scripts/check.ts --json topic:ai-agents  # the result object only
 */
import { rpcEndpoints, Viewer } from "@tredio/chain";
import { deployment } from "@tredio/contracts";
import { FastNearTxIndex, TredioApi } from "@tredio/mcp";
import { AttentionChecker } from "../src/check";
import { renderMarkdown } from "../src/result";
import { topicQueries } from "../src/topic";

const network = process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
const args = process.argv.slice(2);
const json = args.includes("--json");
const topic = args.filter((a) => a !== "--json").join(" ").trim();
if (!topic) {
  console.error('usage: bun scripts/check.ts [--json] "<topic>"');
  process.exit(2);
}
const backend = (process.env.BACKEND_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const viewer = new Viewer(network, rpcEndpoints(network, [], (process.env.FASTNEAR_API_KEYS ?? "").split(",").filter(Boolean)));
const checker = new AttentionChecker({
  api: new TredioApi(backend),
  chain: viewer,
  txIndex: process.env.VERIFY_ORACLE_REPORT === "off" ? null : new FastNearTxIndex(`https://tx.${network === "mainnet" ? "main" : "test"}.fastnear.com`),
  deployment: deployment(network),
  network,
  publicApiUrl: (process.env.PUBLIC_API_URL ?? backend).replace(/\/+$/, ""),
  appUrl: (process.env.APP_URL ?? "https://app.tredio.bid").replace(/\/+$/, ""),
});
const resolution = await checker.resolve(topicQueries(topic, ""));
if (!resolution) {
  console.error(`Tredio does not track "${topic}". Listed now: ${checker.suggestions().join(", ") || "nothing"}`);
  process.exit(1);
}
const result = await checker.check(resolution);
console.log(json ? JSON.stringify(result, null, 2) : renderMarkdown(result));
