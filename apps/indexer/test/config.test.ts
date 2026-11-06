import { expect, test } from "bun:test";
import { FREE_RPM, KEY_RPM, loadConfig, TX_FREE_RPM } from "../src/config";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

test("defaults: testnet, schema indexer, the free rate without a key", () => {
  const c = loadConfig({ ...base, START_BLOCK: "", NEARDATA_API_KEY: "" });
  expect(c.NEAR_NETWORK).toBe("testnet");
  expect(c.INDEXER_SCHEMA).toBe("indexer");
  expect(c.START_BLOCK).toBeUndefined();
  expect(c.NEARDATA_RPM).toBe(FREE_RPM);
  expect(c.neardataUrl).toBe("https://testnet.neardata.xyz");
  expect(c.PORT).toBe(4700);
  expect(c.INDEXER_SOURCE).toBe("txs");
  expect(c.txApiUrl).toBe("https://tx.test.fastnear.com");
  expect(c.TX_API_RPM).toBe(TX_FREE_RPM);
  expect(c.relayers).toEqual(["tredio-relayer.testnet"]);
});

test("the tx feed's hosts, relayers and key", () => {
  const m = loadConfig({ ...base, NEAR_NETWORK: "mainnet" });
  expect(m.txApiUrl).toBe("https://tx.main.fastnear.com");
  expect(m.relayers).toEqual([]);
  const c = loadConfig({ ...base, RELAYER_ACCOUNT_ID: "a.testnet, b.testnet", TX_API_KEY: "k", INDEXER_SOURCE: "blocks" });
  expect(c.relayers).toEqual(["a.testnet", "b.testnet"]);
  expect(c.TX_API_RPM).toBe(KEY_RPM);
  expect(c.INDEXER_SOURCE).toBe("blocks");
  expect(() => loadConfig({ ...base, INDEXER_SOURCE: "rpc" })).toThrow(/INDEXER_SOURCE/);
});

test("a key raises the default rate; explicit values win", () => {
  expect(loadConfig({ ...base, NEARDATA_API_KEY: "k" }).NEARDATA_RPM).toBe(KEY_RPM);
  expect(loadConfig({ ...base, NEARDATA_API_KEY: "k", NEARDATA_RPM: "90" }).NEARDATA_RPM).toBe(90);
  expect(loadConfig({ ...base, NEAR_NETWORK: "mainnet", NEARDATA_URL: "https://x.example/" }).neardataUrl).toBe("https://x.example");
});

test("shared FastNEAR keys feed both feeds, each key adds to the default rate, a feed's own key wins", () => {
  const c = loadConfig({ ...base, FASTNEAR_API_KEYS: "a, b,a" });
  expect(c.txApiKeys).toEqual(["a", "b"]);
  expect(c.neardataKeys).toEqual(["a", "b"]);
  expect(c.TX_API_RPM).toBe(2 * KEY_RPM);
  const own = loadConfig({ ...base, FASTNEAR_API_KEYS: "a,b", TX_API_KEY: "t" });
  expect(own.txApiKeys).toEqual(["t"]);
  expect(own.TX_API_RPM).toBe(KEY_RPM);
  expect(own.neardataKeys).toEqual(["a", "b"]);
  expect(loadConfig(base).txApiKeys).toEqual([]);
});

test("rejects a missing database and unsafe schema names", () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ ...base, INDEXER_SCHEMA: 'x"; drop' })).toThrow(/INDEXER_SCHEMA/);
});
