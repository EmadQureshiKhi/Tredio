import { cached, Viewer } from "@tredio/chain";
import { FastNearTxIndex, TredioApi } from "@tredio/mcp";
import { AttentionChecker } from "./check";
import { formatUsdc, loadConfig } from "./config";
import { DailyLedger } from "./ledger";
import { MarketClient } from "./market";
import { createServer } from "./server";
import { Worker } from "./worker";

const startedAt = Date.now();
const cfg = loadConfig(process.env);
const log = (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service: "agent-market", msg, ...fields }));

const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpc);
const checker = new AttentionChecker({
  api: new TredioApi(cfg.BACKEND_URL),
  chain: viewer,
  txIndex: cfg.VERIFY_ORACLE_REPORT === "on" ? new FastNearTxIndex(cfg.txApiUrl) : null,
  deployment: cfg.deployment,
  network: cfg.NEAR_NETWORK,
  publicApiUrl: cfg.publicApiUrl,
  appUrl: cfg.APP_URL,
  reportTimeoutMs: Math.max(5, cfg.WORK_TIMEOUT_SEC - 15) * 1000,
});
const ledger = new DailyLedger({ price: cfg.price, acceptTokens: cfg.acceptTokens, dailyCap: cfg.DAILY_CAP, freeTestsPerDay: cfg.FREE_TESTS_PER_DAY });
const market = new MarketClient(cfg.MARKET_URL, cfg.MARKET_API_TOKEN);
const worker = new Worker({ market, checker, ledger, maxConcurrent: cfg.MAX_CONCURRENT, maxAttempts: cfg.MAX_ATTEMPTS, workTimeoutMs: cfg.WORK_TIMEOUT_SEC * 1000, log });

const backendUp = cached(
  () =>
    fetch(`${cfg.BACKEND_URL}/live`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok)
      .catch(() => false),
  30_000,
);
const app = createServer({ worker, ledger, network: cfg.NEAR_NETWORK, marketUrl: cfg.MARKET_URL, price: cfg.price, pollIntervalSec: cfg.POLL_INTERVAL_SEC, webhookSecret: cfg.MARKET_WEBHOOK_SECRET ?? null, backendUp, log, startedAt });
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
log({ port: server.port, network: cfg.NEAR_NETWORK, market: cfg.MARKET_URL, backend: cfg.BACKEND_URL, price: `${formatUsdc(cfg.price)} USDC`, dailyCap: cfg.DAILY_CAP, webhooks: Boolean(cfg.MARKET_WEBHOOK_SECRET), registry: cfg.deployment.contracts.registry }, "agent-market listening");

// The day's calls so far, from the market's own record, before any new one is taken.
try {
  log({ counted: await worker.seed(), day: ledger.day }, "daily cap seeded");
} catch (e) {
  log({ error: String((e as Error).message ?? e) }, "could not count today's calls; the cap starts from zero");
}
worker.start(cfg.POLL_INTERVAL_SEC * 1000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    worker.stop();
    server.stop();
    process.exit(0);
  });
}
