import { describe, expect, test } from "bun:test";
import { deployment } from "@tredio/contracts";
import { ChainReader } from "../src/chain";

const trend = (index: number) => ({
  id: "topic:world-cup",
  asset_class: "topic",
  status: "active",
  created_at: 1,
  updated_at: 2,
  status_since: 1,
  index: index * 1_000_000,
  peak_index: 60_000_000,
  surfacer: null,
  review_hash: null,
  asset: null,
});

/** A reader over a fake registry whose index and failures the test controls. */
function reader(ttlMs: number, maxStaleMs: number) {
  const r = new ChainReader(["http://rpc.invalid"], deployment("testnet"), ttlMs, maxStaleMs);
  const registry = { index: 50, reads: 0, fail: false, gate: Promise.resolve() };
  (r.viewer as unknown as { view: (c: string, m: string) => Promise<unknown> }).view = async (_c, method) => {
    await registry.gate;
    if (registry.fail) throw new Error("rpc 429");
    if (method === "trend_count") return 1;
    if (method === "last_run_id") return 7;
    registry.reads++;
    return [trend(registry.index)];
  };
  return { r, registry };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ChainReader", () => {
  test("serves a stale snapshot at once and refreshes it behind the request", async () => {
    const { r, registry } = reader(10, 60_000);
    expect((await r.trends())[0]!.index).toBe(50);
    await sleep(20);
    registry.index = 52;
    let release!: () => void;
    registry.gate = new Promise((resolve) => (release = resolve));
    // The RPC hangs, yet the stale answer comes back immediately.
    expect((await r.trends())[0]!.index).toBe(50);
    release();
    await sleep(5);
    expect((await r.trends())[0]!.index).toBe(52);
    expect(registry.reads).toBe(2);
  });

  test("keeps the snapshot when a refresh fails and waits once it is too old", async () => {
    const { r, registry } = reader(10, 40);
    await r.trends();
    await sleep(20);
    registry.fail = true;
    expect((await r.trends())[0]!.index).toBe(50);
    await sleep(40);
    await expect(r.trends()).rejects.toThrow("rpc 429");
    registry.fail = false;
    expect((await r.trends())[0]!.index).toBe(50);
  });

  test("shares one registry read between concurrent callers", async () => {
    const { r, registry } = reader(10_000, 60_000);
    await Promise.all([r.trends(), r.trends(), r.lastRunId()]);
    expect(registry.reads).toBe(1);
    expect(await r.lastRunId()).toBe(7n);
  });
});
