import { expect, test } from "bun:test";
import { healthApp } from "../src/health";
import type { IngestStatus } from "../src/ingest";

const NOW = Date.parse("2026-11-05T18:30:00Z");

function app(status: Partial<IngestStatus>, running = true) {
  const s: IngestStatus = { height: 100, head: 103, blockTime: new Date(NOW - 5_000), eventsProcessed: 7, startedAt: new Date(NOW - 60_000), beat: NOW - 1_000, ...status };
  return healthApp({ status: () => s, running: () => running, maxLagSec: 60, liveTimeoutSec: 300, now: () => NOW });
}

test("/health is 200 with the lag under the limit", async () => {
  const res = await app({}).request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    alerts: {},
    height: 100,
    head: 103,
    lagBlocks: 3,
    lagSec: 5,
    eventsProcessed: 7,
    startedAt: new Date(NOW - 60_000).toISOString(),
  });
});

test("/health is 503 when behind or before the first block, and says why", async () => {
  const behind = await app({ blockTime: new Date(NOW - 120_000) }).request("/health");
  expect(behind.status).toBe(503);
  expect(((await behind.json()) as { alerts: object }).alerts).toEqual({ lag: "120 s behind the chain" });
  const first = await app({ blockTime: null }).request("/health");
  expect(first.status).toBe(503);
  expect(((await first.json()) as { alerts: object }).alerts).toEqual({ lag: "no block read yet" });
  expect(((await (await app({}, false).request("/health")).json()) as { alerts: object }).alerts).toEqual({ stopped: "not following the chain" });
});

test("/health names refused API keys without failing", async () => {
  const withKeys = (configured: number, refused: number) =>
    healthApp({ status: () => ({ height: 100, head: 103, blockTime: new Date(NOW - 5_000), eventsProcessed: 7, startedAt: new Date(NOW), beat: NOW }), running: () => true, maxLagSec: 60, liveTimeoutSec: 300, keys: { configured, refused: () => refused }, now: () => NOW });
  const all = await withKeys(1, 1).request("/health");
  expect(all.status).toBe(200);
  expect(((await all.json()) as { alerts: object }).alerts).toEqual({ keys: "FastNEAR refused the API key; reading at the keyless rate" });
  expect(((await (await withKeys(3, 1).request("/health")).json()) as { alerts: object }).alerts).toEqual({ keys: "FastNEAR refused 1 of 3 API keys" });
  expect(((await (await withKeys(2, 0).request("/health")).json()) as { alerts: object }).alerts).toEqual({});
});

test("/live ignores lag but not a stalled or ended loop", async () => {
  expect((await app({ blockTime: new Date(NOW - 3_600_000) }).request("/live")).status).toBe(200);
  expect((await app({ beat: NOW - 600_000 }).request("/live")).status).toBe(503);
  expect((await app({}, false).request("/live")).status).toBe(503);
});
