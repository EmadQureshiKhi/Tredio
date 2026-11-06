import { Sender, Viewer, walletWatch } from "@tredio/chain";
import { HyperliquidInfo } from "@tredio/hyperliquid";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { METHOD } from "./method";
import { Oracle } from "./oracle";
import { OutLayerRunner } from "./outlayer";
import { KeySigner } from "./signer";

const cfg = loadConfig(process.env);
const log = (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service: "oracle", msg, ...fields }));
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpc);
const sender = new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.ORACLE_ACCOUNT_ID, privateKey: cfg.ORACLE_PRIVATE_KEY, rpc: cfg.rpc });
const signer = cfg.ORACLE_MODE === "local" ? new KeySigner(cfg.REPORT_SIGNING_KEY!) : null;
const enclave =
  cfg.ORACLE_MODE === "outlayer"
    ? new OutLayerRunner(sender, viewer, {
        contract: cfg.OUTLAYER_CONTRACT,
        wasmUrl: cfg.OUTLAYER_WASM_URL!,
        wasmHash: cfg.OUTLAYER_WASM_HASH!,
        maxSeconds: cfg.OUTLAYER_MAX_SECONDS,
        secrets: cfg.OUTLAYER_SECRETS_PROFILE && cfg.OUTLAYER_SECRETS_ACCOUNT ? { profile: cfg.OUTLAYER_SECRETS_PROFILE, account_id: cfg.OUTLAYER_SECRETS_ACCOUNT } : null,
      })
    : null;
const trusted = await viewer.view<{ tee_signer?: { public_key: string } }>(cfg.deployment.contracts.registry, "get_oracle").catch(() => null);
if (signer && trusted?.tee_signer?.public_key && trusted.tee_signer.public_key !== signer.publicKey) {
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
      await (enclave ? oracle.runEnclave(enclave) : oracle.run());
    } catch (e) {
      oracle.lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      log({ err: oracle.lastError }, "run failed");
    }
    // Runs start on the interval, not after it, so marks stay inside the guard's limit (two minutes on v1 account code, five on v2).
    await Bun.sleep(Math.max(1000, cfg.RUN_INTERVAL_SEC * 1000 - (Date.now() - started)));
  }
})();

const minBalance = BigInt(Math.round(cfg.MIN_BALANCE_NEAR * 1e6)) * 10n ** 18n;
const app = new Hono();
const oracleWallet = walletWatch(viewer, "Oracle", sender.accountId, { min: minBalance });
app.get("/live", (c) => c.json({ live: true }));
app.get("/health", async (c) => {
  const wallet = await oracleWallet();
  const funded = wallet.balance !== null && Number(wallet.balance) >= cfg.MIN_BALANCE_NEAR;
  const recent = oracle.lastRun !== null && Date.now() / 1000 - oracle.lastRun.at < cfg.RUN_INTERVAL_SEC * 5;
  const ok = funded && recent;
  const r = oracle.lastRun;
  return c.json(
    {
      ok,
      service: "oracle",
      network: cfg.NEAR_NETWORK,
      signer: signer ? { kind: signer.kind, publicKey: signer.publicKey } : { kind: "outlayer-tee", wasmHash: cfg.OUTLAYER_WASM_HASH, trustedKey: trusted?.tee_signer?.public_key ?? null },
      wallets: [wallet],
      alerts: funded ? {} : { balance: `below ${cfg.MIN_BALANCE_NEAR} NEAR` },
      lastError: oracle.lastError,
      lastWorkAt: r?.at ?? null,
      lastRun: r,
      facts: [
        ...(r ? [{ label: "Last run", at: r.at }, { label: "Last report", value: r.tx ? `run ${r.runId}: ${r.updated} updates, ${r.created.length} new, ${r.marks} marks` : (r.skipped ?? "none") }] : []),
        { label: "Report key", value: signer ? "local key (bootstrap)" : `OutLayer enclave, build ${cfg.OUTLAYER_WASM_HASH!.slice(0, 12)}`, tone: signer ? "warn" : "ok" },
      ],
      flags: [],
    },
    ok ? 200 : 503,
  );
});
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
log({ port: server.port, network: cfg.NEAR_NETWORK, account: sender.accountId, mode: cfg.ORACLE_MODE, reportKey: signer?.publicKey ?? null, wasmHash: cfg.OUTLAYER_WASM_HASH ?? null }, "oracle listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    server.stop();
    process.exit(0);
  });
}
