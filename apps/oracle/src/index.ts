import { Sender, Viewer, walletHealth } from "@tredio/chain";
import { HyperliquidInfo } from "@tredio/hyperliquid";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { METHOD } from "./method";
import { Oracle } from "./oracle";
import { KeySigner } from "./signer";

const cfg = loadConfig(process.env);
const log = (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service: "oracle", msg, ...fields }));
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpcUrls);
const sender = new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.ORACLE_ACCOUNT_ID, privateKey: cfg.ORACLE_PRIVATE_KEY, rpcUrls: cfg.rpcUrls });
const signer = new KeySigner(cfg.REPORT_SIGNING_KEY);
const trusted = await viewer.view<{ tee_signer?: { public_key: string } }>(cfg.deployment.contracts.registry, "get_oracle").catch(() => null);
if (trusted?.tee_signer?.public_key && trusted.tee_signer.public_key !== signer.publicKey) {
  log({ trusted: trusted.tee_signer.public_key, ours: signer.publicKey }, "the registry trusts another report key; reports will be refused");
}
const oracle = new Oracle(
  viewer,
  sender,
  signer,
  new HyperliquidInfo(cfg.NEAR_NETWORK),
  cfg.deployment,
  {
    backendUrl: cfg.BACKEND_URL,
    backendToken: cfg.BACKEND_TOKEN,
    maxSamplesPerRun: cfg.MAX_SAMPLES_PER_RUN,
    maxCandidatesPerRun: cfg.MAX_CANDIDATES_PER_RUN,
    maxLiveTrends: cfg.MAX_LIVE_TRENDS,
    heartbeatSec: cfg.HEARTBEAT_SEC,
    deviationBps: cfg.DEVIATION_BPS,
    minCreateIndexPoints: cfg.MIN_CREATE_INDEX_POINTS,
    markAssets: cfg.MARK_ASSETS,
    method: METHOD,
  },
  fetch,
  log,
);

let stopped = false;
void (async () => {
  while (!stopped) {
    const started = Date.now();
    try {
      await oracle.run();
    } catch (e) {
      oracle.lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      log({ err: oracle.lastError }, "run failed");
    }
    // Runs start on the interval, not after it, so marks stay inside the guard's two minutes.
    await Bun.sleep(Math.max(1000, cfg.RUN_INTERVAL_SEC * 1000 - (Date.now() - started)));
  }
})();

const minBalance = BigInt(Math.round(cfg.MIN_BALANCE_NEAR * 1e6)) * 10n ** 18n;
const app = new Hono();
app.get("/live", (c) => c.json({ live: true }));
app.get("/health", async (c) => {
  const wallet = await walletHealth(viewer, "Oracle", sender.accountId, { min: minBalance });
  const funded = wallet.balance !== null && Number(wallet.balance) >= cfg.MIN_BALANCE_NEAR;
  const recent = oracle.lastRun !== null && Date.now() / 1000 - oracle.lastRun.at < cfg.RUN_INTERVAL_SEC * 5;
  const ok = funded && recent;
  const r = oracle.lastRun;
  return c.json(
    {
      ok,
      service: "oracle",
      network: cfg.NEAR_NETWORK,
      signer: { kind: signer.kind, publicKey: signer.publicKey },
      wallets: [wallet],
      alerts: funded ? {} : { balance: `below ${cfg.MIN_BALANCE_NEAR} NEAR` },
      lastError: oracle.lastError,
      lastWorkAt: r?.at ?? null,
      lastRun: r,
      facts: [
        ...(r ? [{ label: "Last run", at: r.at }, { label: "Last report", value: r.tx ? `run ${r.runId}: ${r.updated} updates, ${r.created.length} new, ${r.marks} marks` : (r.skipped ?? "none") }] : []),
        { label: "Report key", value: signer.kind === "local-key" ? "local key (bootstrap)" : "OutLayer enclave", tone: signer.kind === "local-key" ? "warn" : "ok" },
      ],
      flags: [],
    },
    ok ? 200 : 503,
  );
});
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
log({ port: server.port, network: cfg.NEAR_NETWORK, account: sender.accountId, reportKey: signer.publicKey, signer: signer.kind }, "oracle listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    server.stop();
    process.exit(0);
  });
}
