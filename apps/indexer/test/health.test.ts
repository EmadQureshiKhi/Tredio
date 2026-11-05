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
    height: 100,
    head: 103,
    lagBlocks: 3,
    lagSec: 5,
    eventsProcessed: 7,
    startedAt: new Date(NOW - 60_000).toISOString(),
  });
});

test("/health is 503 when behind or before the first block", async () => {
  expect((await app({ blockTime: new Date(NOW - 120_000) }).request("/health")).status).toBe(503);
  expect((await app({ blockTime: null }).request("/health")).status).toBe(503);
});

test("/live ignores lag but not a stalled or ended loop", async () => {
  expect((await app({ blockTime: new Date(NOW - 3_600_000) }).request("/live")).status).toBe(200);
  expect((await app({ beat: NOW - 600_000 }).request("/live")).status).toBe(503);
  expect((await app({}, false).request("/live")).status).toBe(503);
});
