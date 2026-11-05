import { expect, test } from "bun:test";
import { deploymentsPath, loadDeployment, Tracker } from "../src/deployments";
import { blockTime, extractEvents } from "../src/extract";
import { silentLog } from "../src/log";
import { Neardata } from "../src/neardata";

const live = process.env.INDEXER_LIVE === "1";

/** Hits FastNEAR's testnet neardata: two requests. Run with INDEXER_LIVE=1. */
test.skipIf(!live)("fetches and reads the testnet final block", async () => {
  const nd = new Neardata({ baseUrl: "https://testnet.neardata.xyz", apiKey: process.env.NEARDATA_API_KEY || undefined, rpm: 60, log: silentLog });
  const head = await nd.finalHeight();
  expect(head).toBeGreaterThan(276_376_358);
  const r = await nd.block(head);
  expect(r.kind).toBe("block");
  if (r.kind !== "block") return;
  expect(r.block.block.header.height).toBe(head);
  expect(r.block.shards.length).toBeGreaterThan(0);
  expect(Math.abs(Date.now() - blockTime(r.block).getTime())).toBeLessThan(10 * 60_000);
  const events = extractEvents(r.block, new Tracker(loadDeployment(deploymentsPath("testnet"))));
  expect(Array.isArray(events)).toBe(true);
}, 60_000);
