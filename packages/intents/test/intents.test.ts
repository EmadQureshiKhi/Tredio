import { describe, expect, test } from "bun:test";
import { depositRequest, hyperliquidFundingRequest, hyperliquidReturnRequest, HYPERLIQUID_USDC_ASSET, isFinal, NEAR_USDC_ASSET, OneClick, OneClickError, withdrawalRequest } from "../src";
import mainnet from "../../../deployments/mainnet.json" with { type: "json" };

describe("1Click requests", () => {
  test("deposits land as USDC on NEAR, refunded on the origin chain", () => {
    const r = depositRequest({ originAsset: "nep141:base-usdc", amount: "5000000", account: "alice.near", refundTo: "0xabc", dry: true, now: 0 });
    expect(r.destinationAsset).toBe(NEAR_USDC_ASSET);
    expect(r.recipient).toBe("alice.near");
    expect(r.refundType).toBe("ORIGIN_CHAIN");
    expect(r.confidentiality).toBeUndefined();
    expect(r.deadline).toBe(new Date(3_600_000).toISOString());
  });

  test("withdrawals start from USDC on NEAR and refund the account", () => {
    const r = withdrawalRequest({ destinationAsset: "nep141:sol-usdc", amount: "1000000", account: "alice.near", recipient: "SoLaNa", dry: false });
    expect(r.originAsset).toBe(NEAR_USDC_ASSET);
    expect(r.refundTo).toBe("alice.near");
    expect(r.dry).toBe(false);
  });

  test("Hyperliquid funding goes to the perps balance asset", () => {
    expect(hyperliquidFundingRequest({ amount: "1000000", account: "a.near", hyperliquidAddress: "0x1", dry: true }).destinationAsset).toBe(HYPERLIQUID_USDC_ASSET);
  });

  test("USDC back from Hyperliquid starts from the perps asset (8 decimals), lands on NEAR and refunds the Hyperliquid address", () => {
    const r = hyperliquidReturnRequest({ amount: "2500000", account: "alice.near", hyperliquidAddress: "0xabc", dry: false, now: 0 });
    expect(r.originAsset).toBe(HYPERLIQUID_USDC_ASSET);
    expect(r.amount).toBe("250000000");
    expect(r.destinationAsset).toBe(NEAR_USDC_ASSET);
    expect(r.recipient).toBe("alice.near");
    expect(r.refundTo).toBe("0xabc");
    expect(r.refundType).toBe("ORIGIN_CHAIN");
    expect(r.depositType).toBe("ORIGIN_CHAIN");
  });

  test("final states", () => {
    expect(isFinal("SUCCESS")).toBe(true);
    expect(isFinal("PROCESSING")).toBe(false);
  });
});

describe("OneClick client", () => {
  test("sends the partner JWT and surfaces 1Click's message", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const client = new OneClick({
      jwt: "jwt-1",
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: (init?.headers as Record<string, string>)["x-api-key"] });
        return new Response(JSON.stringify({ message: "amount is too low" }), { status: 400 });
      },
    });
    const err = await client.quote(depositRequest({ originAsset: "x", amount: "1", account: "a.near", refundTo: "b", dry: true })).catch((e) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect((err as OneClickError).message).toContain("amount is too low");
    expect(seen[0]).toEqual({ url: "https://1click.chaindefuser.com/v0/quote", auth: "jwt-1" });
  });

  test("asks for confidentiality only with a partner JWT", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), new Response("{}"));
    const req = depositRequest({ originAsset: "x", amount: "1", account: "a.near", refundTo: "b", dry: true });
    await new OneClick({ jwt: "j", fetchImpl }).quote(req);
    await new OneClick({ fetchImpl }).quote(req);
    expect((bodies[0] as { confidentiality?: string }).confidentiality).toBe("basic");
    expect((bodies[1] as { confidentiality?: string }).confidentiality).toBeUndefined();
    expect(new OneClick({ jwt: "j" }).confidential(req)).toBe(true);
    expect(new OneClick().confidential(req)).toBe(false);
  });

  test("caches the token list", async () => {
    let calls = 0;
    const client = new OneClick({ fetchImpl: async () => (calls++, new Response("[]")) });
    await client.tokens();
    await client.tokens();
    expect(calls).toBe(1);
  });
});

test("#mainnet: 1Click's NEAR USDC is the USDC the mainnet contracts settle in", () => {
  expect(NEAR_USDC_ASSET).toBe(`nep141:${mainnet.contracts.usdc}`);
});
