import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The real `tredio-mcp` binary over stdio against a running API and NEAR testnet. Runs only with
 * TREDIO_LIVE=1 (the API at TREDIO_API_URL, default the hosted https://api.tredio.bid):
 *
 *   TREDIO_LIVE=1 bun test test/live.test.ts
 */
const live = process.env.TREDIO_LIVE === "1";
const API = process.env.TREDIO_API_URL ?? "https://api.tredio.bid";

describe.skipIf(!live)("tredio-mcp live on testnet", () => {
  let client: Client;
  const data = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text?: string }> };
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    return r.structuredContent!;
  };
  let trend: string;

  beforeAll(async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string" && !e[0].startsWith("TREDIO_X402_")));
    client = new Client({ name: "live-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: "bun", args: [new URL("../src/bin.ts", import.meta.url).pathname], env: { ...env, TREDIO_API_URL: API, NEAR_NETWORK: "testnet" }, stderr: "ignore" }));
  });
  afterAll(async () => {
    await client?.close();
  });

  test("lists trends and reads one from the API and the registry", async () => {
    const l = await data("list_trends");
    expect(l.trends.length).toBeGreaterThan(0);
    trend = (l.trends.find((t: { status: string }) => t.status === "active") ?? l.trends[0]).identifier;
    const t = await data("get_trend", { identifier: trend });
    expect(t.onChain.index).toBeGreaterThanOrEqual(0);
    expect(t.onChain.registry).toBe("registry.tredio.testnet");
  }, 60_000);

  test("verifies the newest checkpoint against the oracle's signature", async () => {
    const v = await data("verify_index", { identifier: trend });
    expect(v.reason).toBeUndefined();
    expect(v).toMatchObject({ verified: true, checks: { signature: true, transactionSucceeded: true, observedAtMatches: true, indexWritten: true } });
  }, 90_000);

  test("reads the markets of the trend", async () => {
    const t = await data("get_trend", { identifier: trend });
    const series = t.markets.series[0];
    if (series) expect((await data("get_market", { series: series.series })).series).toBe(series.series);
    expect((await data("get_perp_market", { trend })).maxLeverage).toBe(3);
    if (t.markets.coin) expect((await data("get_coin", { trend, buyUsdc: "1" })).coin).toBe(t.markets.coin.account);
    expect((await data("get_index_history", { identifier: trend, source: "chain" })).count).toBeGreaterThan(0);
  }, 90_000);

  test("status, leaders and the radar", async () => {
    expect((await data("get_status")).network).toBe("testnet");
    expect(Array.isArray((await data("get_leaders")).traders)).toBe(true);
    expect(Array.isArray((await data("list_candidates")).candidates)).toBe(true);
  }, 60_000);
});
