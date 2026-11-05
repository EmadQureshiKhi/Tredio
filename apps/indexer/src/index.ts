/** Tredio indexer: follows the neardata block stream into Postgres and serves /health and /live. */
import { healthApp } from "./health";
import { Ingestor } from "./ingest";
import { Neardata } from "./neardata";
import { createLog } from "./log";
import { type Runtime, setup } from "./setup";

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
const neardata = new Neardata({
  baseUrl: cfg.neardataUrl,
  apiKey: cfg.NEARDATA_API_KEY,
  rpm: cfg.NEARDATA_RPM,
  log,
  signal: stop.signal,
  onAttempt: () => beat(),
});
const ingestor = new Ingestor({
  sql,
  neardata,
  tracker,
  network: cfg.NETWORK,
  startBlock: rt.startBlock,
  concurrency: cfg.NEARDATA_CONCURRENCY,
  pollMs: cfg.POLL_MS,
  log,
  signal: stop.signal,
});
beat = () => ingestor.beat();

let running = true;
const server = Bun.serve({
  port: cfg.PORT,
  fetch: healthApp({
    status: () => ingestor.status,
    running: () => running,
    maxLagSec: cfg.MAX_LAG_SEC,
    liveTimeoutSec: cfg.LIVE_TIMEOUT_SEC,
  }).fetch,
});
log.info("indexer up", {
  network: cfg.NETWORK,
  schema: cfg.INDEXER_SCHEMA,
  neardata: cfg.neardataUrl,
  apiKey: Boolean(cfg.NEARDATA_API_KEY),
  rpm: cfg.NEARDATA_RPM,
  startBlock: rt.startBlock,
  port: server.port,
});

let exitCode = 0;
const shutdown = (signal: string) => {
  if (stop.signal.aborted) return;
  log.info("stopping", { signal });
  stop.abort();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await ingestor.run();
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
