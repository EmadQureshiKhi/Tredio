import { expect, test } from "bun:test";
import { FREE_RPM, KEY_RPM, loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

test("defaults: testnet, schema indexer, the free rate without a key", () => {
  const c = loadConfig({ ...base, START_BLOCK: "", NEARDATA_API_KEY: "" });
  expect(c.NETWORK).toBe("testnet");
  expect(c.INDEXER_SCHEMA).toBe("indexer");
  expect(c.START_BLOCK).toBeUndefined();
  expect(c.NEARDATA_RPM).toBe(FREE_RPM);
  expect(c.neardataUrl).toBe("https://testnet.neardata.xyz");
  expect(c.PORT).toBe(4600);
});

test("a key raises the default rate; explicit values win", () => {
  expect(loadConfig({ ...base, NEARDATA_API_KEY: "k" }).NEARDATA_RPM).toBe(KEY_RPM);
  expect(loadConfig({ ...base, NEARDATA_API_KEY: "k", NEARDATA_RPM: "90" }).NEARDATA_RPM).toBe(90);
  expect(loadConfig({ ...base, NETWORK: "mainnet", NEARDATA_URL: "https://x.example/" }).neardataUrl).toBe("https://x.example");
});

test("rejects a missing database and unsafe schema names", () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ ...base, INDEXER_SCHEMA: 'x"; drop' })).toThrow(/INDEXER_SCHEMA/);
});
