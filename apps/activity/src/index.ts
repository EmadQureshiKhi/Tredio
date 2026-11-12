import { Sender, Viewer, walletWatch } from "@tredio/chain";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { loadPersonas } from "./personas";
import { Runner } from "./runner";

/** When this process started (unix seconds): the status page shows a recent restart. */
const STARTED_AT = Math.floor(Date.now() / 1000);
const NEAR = 10n ** 24n;
const near = (n: number) => (BigInt(Math.round(n * 1e6)) * NEAR) / 1_000_000n;

const cfg = loadConfig(process.env);
const log = (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service: "activity", msg, ...fields }));
const personas = loadPersonas(cfg.PERSONAS_FILE);
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpc);
const funder = new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.FUNDER_ACCOUNT_ID, privateKey: cfg.FUNDER_PRIVATE_KEY, rpc: cfg.rpc });
const runner = new Runner(personas, viewer, funder, cfg.deployment, { api: cfg.BACKEND_URL, rpc: cfg.rpc, gasKeyMin: near(cfg.GAS_KEY_MIN_NEAR), gasKeyTopUp: near(cfg.GAS_KEY_TOPUP_NEAR) }, log);
/** The personas act through the end of ACTIVITY_UNTIL (UTC). */
const until = Date.parse(`${cfg.ACTIVITY_UNTIL}T23:59:59Z`);
const finished = () => Date.now() > until;
const averageGapMs = (86_400 / cfg.ACTIONS_PER_DAY) * 1000;

let stopped = false;
void (async () => {
  log({ personas: personas.length, until: cfg.ACTIVITY_UNTIL, actionsPerDay: cfg.ACTIONS_PER_DAY }, "activity started");
  while (!stopped && !finished()) {
    await runner.turn();
    // Spread turns irregularly, as people act: half to one and a half times the average gap.
    await Bun.sleep(averageGapMs * (0.5 + Math.random()));
  }
  if (finished()) log({ until: cfg.ACTIVITY_UNTIL }, "activity window over; the personas rest");
})();

const funderWallet = walletWatch(viewer, "Activity funder", funder.accountId, { min: NEAR });
const app = new Hono();
app.get("/live", (c) => c.json({ live: true }));
app.get("/health", async (c) => {
  const wallet = await funderWallet();
  const funded = wallet.balance !== null && Number(wallet.balance) >= 1;
  // Turns land every 6 to 18 minutes on average; two hours without one, while not finished, is a stall.
  const recent = finished() || Date.now() / 1000 - (runner.lastActionAt ?? STARTED_AT) < 2 * 3600;
  const alerts: Record<string, string> = {};
  if (!funded) alerts.balance = "below 1 NEAR: the funder tops up the personas' gas keys";
  if (!recent) alerts.stale = `no action for ${Math.round((Date.now() / 1000 - (runner.lastActionAt ?? STARTED_AT)) / 60)} min: ${runner.lastError ?? "no error"}`;
  const ok = funded && recent;
  return c.json(
    {
      ok,
      service: "activity",
      network: cfg.NEAR_NETWORK,
      startedAt: STARTED_AT,
      wallets: [wallet],
      alerts,
      lastError: runner.lastError,
      lastWorkAt: runner.lastActionAt,
      personas: personas.length,
      until: cfg.ACTIVITY_UNTIL,
      counts: runner.counts,
      failures: runner.failures,
      recent: runner.recent.slice(0, 10),
      facts: [
        { label: "Personas", value: `${personas.length}, through ${cfg.ACTIVITY_UNTIL}` },
        { label: "Actions since start", value: String(Object.values(runner.counts).reduce((a, b) => a + b, 0)) },
        ...(runner.lastActionAt ? [{ label: "Last action", at: runner.lastActionAt }] : []),
      ],
      flags: finished() ? ["finished"] : [],
    },
    ok ? 200 : 503,
  );
});
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
log({ port: server.port, network: cfg.NEAR_NETWORK, funder: funder.accountId, backend: cfg.BACKEND_URL }, "activity listening");

process.on("SIGTERM", () => {
  stopped = true;
  server.stop();
  process.exit(0);
});
