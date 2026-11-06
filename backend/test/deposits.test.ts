import { describe, expect, test } from "bun:test";
import { DRY_RUN_ACCOUNT, HYPERLIQUID_USDC_ASSET, NEAR_USDC_ASSET, OneClick, type QuoteRequest } from "@tredio/intents";
import type { MiddlewareHandler } from "hono";
import type { Sql } from "../src/db";
import { depositRoutes } from "../src/deposits/routes";
import { quietLog } from "./helpers";

/**
 * The quote route on testnet: every quote is dry (no deposit address, nothing stored), so this needs
 * no database. It checks which 1Click route each direction asks for.
 */

const HL = "0x5e9ee1089755c3435139848e47e6635505d5a13a";

function app() {
  const sent: QuoteRequest[] = [];
  const oneClick = new OneClick({
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as QuoteRequest;
      sent.push(req);
      const quote = { amountIn: req.amount, amountInFormatted: "1", amountInUsd: "1", amountOut: "1", amountOutFormatted: "1", amountOutUsd: "1", minAmountOut: "1", timeEstimate: 30 };
      return new Response(JSON.stringify({ quote, quoteRequest: req, signature: "ed25519:x", timestamp: new Date(0).toISOString() }));
    }) as unknown as typeof fetch,
  });
  const signedIn: MiddlewareHandler<{ Variables: { user: string; token: string } }> = async (c, next) => {
    c.set("user", "alice.testnet");
    await next();
  };
  const routes = depositRoutes({ sql: null as unknown as Sql, oneClick, network: "testnet", signedIn, log: quietLog, now: () => 0 });
  const quote = (body: unknown) => routes.request("/deposits/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { sent, quote };
}

describe("deposit quotes on testnet", () => {
  test("funding Hyperliquid sends USDC on NEAR to the account's Hyperliquid address", async () => {
    const { sent, quote } = app();
    const res = await quote({ direction: "hyperliquid", amount: "2000000", hyperliquidAddress: HL });
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ dry: true, originAsset: NEAR_USDC_ASSET, destinationAsset: HYPERLIQUID_USDC_ASSET, amount: "2000000", recipient: HL });
  });

  test("USDC back from Hyperliquid: from the perps asset in 8 decimals to the account on NEAR, refunds to the Hyperliquid address", async () => {
    const { sent, quote } = app();
    const res = await quote({ direction: "from-hyperliquid", amount: "2000000", hyperliquidAddress: HL });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dry: boolean; direction: string }).direction).toBe("from-hyperliquid");
    expect(sent[0]).toMatchObject({ dry: true, originAsset: HYPERLIQUID_USDC_ASSET, destinationAsset: NEAR_USDC_ASSET, amount: "200000000", recipient: DRY_RUN_ACCOUNT, refundTo: HL, refundType: "ORIGIN_CHAIN" });
  });

  test("a Hyperliquid address must be a 0x address", async () => {
    const { sent, quote } = app();
    expect((await quote({ direction: "from-hyperliquid", amount: "2000000", hyperliquidAddress: "alice.near" })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
