import { describe, expect, test } from "bun:test";
import { base58Encode } from "@tredio/chain";
import { deploymentPlan, isDeployed } from "@tredio/contracts";
import { loadConfig } from "../src/config";

/** One switch, NEAR_NETWORK, takes the API to mainnet once deployments/mainnet.json is live. #mainnet */
describe("network switch", () => {
  const base = { DATABASE_URL: "postgres://unused", ORACLE_TOKEN: "t".repeat(32) };
  const live = JSON.stringify({ ...deploymentPlan("mainnet"), status: "live" });

  test("mainnet refuses to start while its contracts are only planned", () => {
    if (isDeployed("mainnet")) return;
    expect(() => loadConfig({ ...base, NEAR_NETWORK: "mainnet" })).toThrow(/not deployed on mainnet yet/);
  });

  test("mainnet needs the activation ticket key, since its relayer creates accounts only with a ticket", () => {
    expect(() => loadConfig({ ...base, NEAR_NETWORK: "mainnet", DEPLOYMENT_JSON: live })).toThrow(/ACTIVATION_TICKET_KEY/);
    const key = `ed25519:${base58Encode(new Uint8Array(64).fill(7))}`;
    const c = loadConfig({ ...base, NEAR_NETWORK: "mainnet", DEPLOYMENT_JSON: live, ACTIVATION_TICKET_KEY: key });
    expect(c.deployment.contracts.usdc).toBe("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    expect(c.rpc.map((e) => e.url)).toEqual(["https://rpc.mainnet.fastnear.com", "https://rpc.intea.rs", "https://near.drpc.org"]);
  });
});
