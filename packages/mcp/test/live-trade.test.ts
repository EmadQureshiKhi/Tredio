import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The trade tools through the real `tredio-mcp` binary over stdio, sending real transactions on
 * NEAR testnet (test USDC, no value). Runs only with TREDIO_LIVE_TRADE=1 and one trading key in
 * env, against the API at TREDIO_API_URL (default the hosted https://api.tredio.bid):
 *
 *   TREDIO_LIVE_TRADE=1 TREDIO_TRADER_ACCOUNT=<account> TREDIO_TRADER_PRIVATE_KEY=ed25519:... bun test test/live-trade.test.ts
 *   TREDIO_LIVE_TRADE=1 TREDIO_SESSION_ACCOUNT=0u... TREDIO_SESSION_KEY=ed25519:... bun test test/live-trade.test.ts
 *
 * The account needs test USDC (the `faucet` on the USDC contract) and, for a NEAR account, about
 * 1 NEAR for gas and storage. The run writes its own small policy and a ledger in a temporary
 * folder, and prints every transaction. TREDIO_LIVE_TREND picks the trend; TREDIO_LIVE_CALL=1
 * also posts a call through the API.
 */
const live = process.env.TREDIO_LIVE_TRADE === "1";
const API = process.env.TREDIO_API_URL ?? "https://api.tredio.bid";
const POLICY = {
  dailyCapUsdc: "10",
  tools: { buy_outcome: { maxUsdc: "2" }, sell_outcome: true, open_perp: { maxUsdc: "3" }, close_perp: true, add_perp_margin: { maxUsdc: "1" }, buy_coin: { maxUsdc: "1" }, sell_coin: true, post_call: true },
};

describe.skipIf(!live)("trade tools live on testnet", () => {
  let client: Client;
  let dir: string;
  let kind: "session" | "account";
  let trend: string;
  const hashes: Record<string, string> = {};
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text?: string }> };
    if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
    return r.structuredContent!;
  };
  const send = async (name: string, args: Record<string, unknown>) => {
    const dry = await call(name, args);
    expect(dry.blocker).toBeNull();
    const r = await call(name, { ...args, confirm: true });
    expect(r.sent).toBe(true);
    hashes[name] = r.hash;
    console.log(`${name}: ${r.hash} ${JSON.stringify(r.result)}`);
    return r;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tredio-live-trade-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string" && !/^TREDIO_(X402_|POLICY|LEDGER)/.test(e[0])));
    client = new Client({ name: "live-trade", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [new URL("../src/bin.ts", import.meta.url).pathname],
        env: { ...env, TREDIO_API_URL: API, NEAR_NETWORK: "testnet", TREDIO_POLICY: JSON.stringify(POLICY), TREDIO_LEDGER_FILE: join(dir, "ledger.json") },
        stderr: "inherit",
      }),
    );
    const p = await call("get_trading_policy");
    kind = p.signer.path.startsWith("session") ? "session" : "account";
    console.log(`signer: ${p.signer.path} ${p.signer.account}`);
  });
  afterAll(async () => {
    await client?.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify(hashes, null, 2));
  });

  test("finds a trend whose 24h Up market fills now", async () => {
    const candidates: string[] = process.env.TREDIO_LIVE_TREND ? [process.env.TREDIO_LIVE_TREND] : (await call("list_trends")).trends.filter((t: { status: string }) => t.status === "active").map((t: { identifier: string }) => t.identifier);
    for (const id of candidates) {
      const dry = await call("buy_outcome", { trend: id, window: "24h", side: "up", usdc: "1" });
      if (dry.ready) {
        trend = id;
        break;
      }
    }
    expect(trend).toBeDefined();
    console.log(`trend: ${trend}`);
  }, 120_000);

  test("buys Up, then sells half of it back", async () => {
    const buy = await send("buy_outcome", { trend, window: "24h", side: "up", usdc: "1" });
    const half = (Math.floor((Number(buy.result.tokensReceived) / 2) * 1000) / 1000).toFixed(3);
    await send("sell_outcome", { series: buy.result.series, side: "up", tokens: half });
  }, 180_000);

  test("opens a perp and closes it", async () => {
    const open = await send("open_perp", { trend, side: "long", margin: "2", leverage: 1 });
    await send("close_perp", { position: open.result.position });
  }, 180_000);

  test("buys a coin and sells it back (a NEAR account's own key)", async () => {
    if (kind === "session") {
      const r = await call("buy_coin", { trend, usdc: "1" });
      expect(r.blocker).toContain("owner action");
      return;
    }
    const buy = await send("buy_coin", { trend, usdc: "1" });
    await send("sell_coin", { trend, coins: buy.result.coinsReceived });
  }, 180_000);

  test("posts a call", async () => {
    if (process.env.TREDIO_LIVE_CALL !== "1") return;
    const r = await call("post_call", { trend, direction: "up", horizon: "24h", note: "tredio-mcp live check", confirm: true });
    expect(r.posted).toBe(true);
    hashes.post_call = `call:${r.call.id}`;
    console.log(`post_call: ${r.call.id} by ${r.caller}`);
  }, 60_000);

  test("the ledger holds every trade with its transaction", async () => {
    const p = await call("get_trading_policy");
    const sent = p.today.trades.filter((e: { status: string }) => e.status === "sent");
    expect(sent.map((e: { hash: string }) => e.hash).sort()).toEqual(Object.values(hashes).sort());
    expect(Number(p.today.spentUsdc)).toBeLessThanOrEqual(10);
  }, 30_000);
});
