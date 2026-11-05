import { Sender, Viewer, walletHealth } from "@tredio/chain";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { Executor } from "./executor";
import { Keeper } from "./keeper";

const cfg = loadConfig(process.env);
const log = (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service: "keeper", msg, ...fields }));
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpcUrls);
const sender = new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.KEEPER_ACCOUNT_ID, privateKey: cfg.KEEPER_PRIVATE_KEY, gasKeyLanes: cfg.KEEPER_GAS_KEY_LANES, rpcUrls: cfg.rpcUrls });
const executor = new Executor(sender, log);
const rotating = cfg.ROTATION_URL
  ? async () => {
      const r = (await (await fetch(cfg.ROTATION_URL!, { signal: AbortSignal.timeout(3000) })).json()) as { rotating?: string[] };
      return new Set(r.rotating ?? []);
    }
  : undefined;
const keeper = new Keeper(
  viewer,
  cfg.deployment,
  executor,
  {
    seriesWindows: cfg.SERIES_WINDOWS,
    coins: cfg.COINS === "on",
    settleDelaySec: cfg.SETTLE_DELAY_SEC,
    scanIntervalSec: cfg.SCAN_INTERVAL_SEC,
    maxActionsPerScan: cfg.MAX_ACTIONS_PER_SCAN,
    staleAlertSec: cfg.STALE_ALERT_SEC,
    rotating,
  },
  log,
);
keeper.start();

const minBalance = BigInt(Math.round(cfg.MIN_BALANCE_NEAR * 1e6)) * 10n ** 18n;
const app = new Hono();
app.get("/live", (c) => c.json({ live: true }));
app.get("/health", async (c) => {
  const wallet = await walletHealth(viewer, "Keeper", sender.accountId, { min: minBalance, gasKeys: [sender.publicKey] });
  const funded = wallet.balance !== null && Number(wallet.balance) >= cfg.MIN_BALANCE_NEAR;
  const scanned = keeper.lastScan !== null && Date.now() / 1000 - keeper.lastScan.at < cfg.SCAN_INTERVAL_SEC * 10;
  const alerts: Record<string, string> = {};
  if (!funded) alerts.balance = `below ${cfg.MIN_BALANCE_NEAR} NEAR`;
  if (keeper.oracle.stale > 0) alerts.stale = `${keeper.oracle.stale} live trends without an oracle update: ${keeper.oracle.staleIds.join(", ")}`;
  const sent = Object.values(executor.sent).reduce((a, n) => a + (n ?? 0), 0);
  const ok = funded && scanned;
  return c.json(
    {
      ok,
      service: "keeper",
      network: cfg.NEAR_NETWORK,
      wallets: [wallet],
      alerts,
      lastError: keeper.lastScanError ?? executor.lastError,
      lastWorkAt: keeper.lastScan?.at ?? null,
      oracle: { live: keeper.oracle.live, stale: keeper.oracle.stale },
      actions: { sent: executor.sent, failed: executor.failed, inFlight: executor.pending },
      facts: [
        ...(keeper.lastScan ? [{ label: "Last scan", at: keeper.lastScan.at }, { label: "Planned last scan", value: String(keeper.lastScan.actions) }] : []),
        { label: "Oracle", value: `${keeper.oracle.live} live, ${keeper.oracle.stale} stale`, tone: keeper.oracle.stale > 0 ? "bad" : "ok" },
        { label: "Actions", value: `${sent} sent, ${executor.failed} failed`, tone: executor.failed > 0 ? "warn" : undefined },
      ],
      flags: [],
    },
    ok ? 200 : 503,
  );
});
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
log({ port: server.port, network: cfg.NEAR_NETWORK, account: sender.accountId, key: sender.publicKey, lanes: cfg.KEEPER_GAS_KEY_LANES }, "keeper listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    keeper.stop();
    server.stop();
    process.exit(0);
  });
}
