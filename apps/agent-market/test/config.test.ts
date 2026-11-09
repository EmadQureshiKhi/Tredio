import { describe, expect, test } from "bun:test";
import { formatUsdc, loadConfig, microUsdc } from "../src/config";

const TOKEN = `aat_${"ab".repeat(16)}`;

describe("config", () => {
  test("defaults: testnet, the local API, the live market, 0.05 USDC a call, 200 calls a day", () => {
    const c = loadConfig({ MARKET_API_TOKEN: TOKEN });
    expect(c.PORT).toBe(4800);
    expect(c.NEAR_NETWORK).toBe("testnet");
    expect(c.BACKEND_URL).toBe("http://localhost:4000");
    expect(c.publicApiUrl).toBe("http://localhost:4000");
    expect(c.MARKET_URL).toBe("https://market.near.ai");
    expect(c.price).toBe(50_000n);
    expect(c.acceptTokens).toEqual(["USDC", "USD"]);
    expect(c.DAILY_CAP).toBe(200);
    expect(c.FREE_TESTS_PER_DAY).toBe(5);
    expect(c.VERIFY_ORACLE_REPORT).toBe("on");
    expect(c.txApiUrl).toBe("https://tx.test.fastnear.com");
    // The registry comes from the deployment file, never from this service's settings.
    expect(c.deployment.contracts.registry).toBe("registry.tredio.testnet");
    expect(c.rpc.length).toBeGreaterThan(0);
  });

  test("the agent token is required and must look like the market's (aat_ and 32 hex)", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ MARKET_API_TOKEN: "sk_live_abc" })).toThrow(/aat_/);
    expect(() => loadConfig({ MARKET_API_TOKEN: `aat_${"AB".repeat(16)}` })).toThrow(/aat_/);
  });

  test("URLs lose trailing slashes; PUBLIC_API_URL overrides the links; empty values fall back to defaults", () => {
    const c = loadConfig({ MARKET_API_TOKEN: TOKEN, BACKEND_URL: "http://backend:4000/", PUBLIC_API_URL: "https://api.tredio.bid/", MARKET_URL: "http://localhost:4890/", NEAR_RPC_URLS: "", MARKET_WEBHOOK_SECRET: "" });
    expect(c.BACKEND_URL).toBe("http://backend:4000");
    expect(c.publicApiUrl).toBe("https://api.tredio.bid");
    expect(c.MARKET_URL).toBe("http://localhost:4890");
    expect(c.MARKET_WEBHOOK_SECRET).toBeUndefined();
  });

  test("price, cap and webhook secret are checked", () => {
    expect(() => loadConfig({ MARKET_API_TOKEN: TOKEN, PRICE_USDC: "0" })).toThrow(/above 0/);
    expect(() => loadConfig({ MARKET_API_TOKEN: TOKEN, PRICE_USDC: "0.0000001" })).toThrow();
    expect(() => loadConfig({ MARKET_API_TOKEN: TOKEN, PRICE_USDC: "-1" })).toThrow();
    expect(() => loadConfig({ MARKET_API_TOKEN: TOKEN, DAILY_CAP: "0" })).toThrow();
    expect(() => loadConfig({ MARKET_API_TOKEN: TOKEN, MARKET_WEBHOOK_SECRET: "short" })).toThrow(/32/);
    const c = loadConfig({ MARKET_API_TOKEN: TOKEN, PRICE_USDC: "1.25", ACCEPT_TOKENS: "usdc, usd", DAILY_CAP: "50", POLL_INTERVAL_SEC: "30" });
    expect(c.price).toBe(1_250_000n);
    expect(c.acceptTokens).toEqual(["USDC", "USD"]);
    expect(c.DAILY_CAP).toBe(50);
  });

  test("mainnet refuses to start until Tredio is deployed there", () => {
    // Mainnet is not deployed yet, so loading it fails on the deployment, never silently on testnet ids.
    expect(() => loadConfig({ MARKET_API_TOKEN: TOKEN, NEAR_NETWORK: "mainnet" })).toThrow(/not deployed/);
  });

  test("USDC amounts convert without floats", () => {
    expect(microUsdc("0.05")).toBe(50_000n);
    expect(microUsdc("25.000000000000")).toBe(25_000_000n);
    expect(microUsdc("0.050000000000")).toBe(50_000n);
    expect(microUsdc("0.0499999")).toBe(49_999n);
    expect(() => microUsdc("1e3")).toThrow();
    expect(formatUsdc(50_000n)).toBe("0.05");
    expect(formatUsdc(12_000_000n)).toBe("12.00");
    expect(formatUsdc(1_234_567n)).toBe("1.234567");
  });
});
