/**
 * Tredio indexer: follows FastNEAR's transactions API (default) or neardata's block stream into
 * Postgres and serves /health and /live.
 */
import { healthApp } from "./health";
import { Ingestor, type IngestStatus } from "./ingest";
import { createLog } from "./log";
import { Neardata } from "./neardata";
import { type Runtime, setup } from "./setup";
import { TxApi } from "./txapi";
import { TxIngestor } from "./txfeed";

let rt: Runtime;
try {
  rt = await setup();
} catch (e) {
  createLog().error("indexer cannot start", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
const { cfg, log, sql, tracker } = rt;
const stop = new AbortController();
let beat = () => {};
const common = { sql, tracker, network: cfg.NEAR_NETWORK, startBlock: rt.startBlock, log, signal: stop.signal };

let feed: { status: IngestStatus; beat(): void; run(): Promise<void> };
let source: Record<string, unknown>;
if (cfg.INDEXER_SOURCE === "txs") {
  const api = new TxApi({ baseUrl: cfg.txApiUrl, apiKeys: cfg.txApiKeys, rpm: cfg.TX_API_RPM, log, signal: stop.signal, onAttempt: () => beat() });
  const core = [...new Set([...tracker.coreAccounts(), ...cfg.relayers])];
  feed = new TxIngestor({
    ...common,
    api,
    coreAccounts: core,
    safetyBlocks: cfg.TX_SAFETY_BLOCKS,
    lookbackBlocks: cfg.TX_LOOKBACK_BLOCKS,
    backfillWindow: cfg.TX_BACKFILL_WINDOW,
    slowPerCycle: cfg.TX_SLOW_PER_CYCLE,
    pollMs: cfg.TX_POLL_MS,
    pendingMaxBlocks: cfg.TX_PENDING_MAX_BLOCKS,
  });
  source = { source: "txs", txApi: cfg.txApiUrl, apiKeys: cfg.txApiKeys.length, rpm: cfg.TX_API_RPM, relayers: cfg.relayers };
} else {
  const neardata = new Neardata({ baseUrl: cfg.neardataUrl, apiKeys: cfg.neardataKeys, rpm: cfg.NEARDATA_RPM, log, signal: stop.signal, onAttempt: () => beat() });
  feed = new Ingestor({ ...common, neardata, concurrency: cfg.NEARDATA_CONCURRENCY, pollMs: cfg.POLL_MS });
  source = { source: "blocks", neardata: cfg.neardataUrl, apiKeys: cfg.neardataKeys.length, rpm: cfg.NEARDATA_RPM };
}
beat = () => feed.beat();

let running = true;
const server = Bun.serve({
  port: cfg.PORT,
  fetch: healthApp({
    status: () => feed.status,
    running: () => running,
    maxLagSec: cfg.MAX_LAG_SEC,
    liveTimeoutSec: cfg.LIVE_TIMEOUT_SEC,
  }).fetch,
});
log.info("indexer up", { network: cfg.NEAR_NETWORK, schema: cfg.INDEXER_SCHEMA, ...source, startBlock: rt.startBlock, port: server.port });

let exitCode = 0;
const shutdown = (signal: string) => {
  if (stop.signal.aborted) return;
  log.info("stopping", { signal });
  stop.abort();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await feed.run();
} catch (e) {
  exitCode = 1;
  log.error("ingest stopped", { error: e instanceof Error ? e.message : String(e) });
} finally {
  running = false;
  server.stop(true);
  await rt.release();
  await sql.end({ timeout: 5 });
}
process.exit(exitCode);
