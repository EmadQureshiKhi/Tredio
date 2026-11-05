import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Sender, Viewer, walletHealth } from "@tredio/chain";
import { Hono } from "hono";
import { loadConfig } from "./config";
import type { TargetMemory } from "./plan";
import { TopUp } from "./topup";

const cfg = loadConfig(process.env);
const log = (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service: "topup", msg, ...fields }));
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpcUrls);
const treasury = new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.TREASURY_ACCOUNT_ID, privateKey: cfg.TREASURY_PRIVATE_KEY, rpcUrls: cfg.rpcUrls });
const minter =
  cfg.USDC_MINTER_ACCOUNT_ID && cfg.USDC_MINTER_PRIVATE_KEY ? new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.USDC_MINTER_ACCOUNT_ID, privateKey: cfg.USDC_MINTER_PRIVATE_KEY, rpcUrls: cfg.rpcUrls }) : null;
const store = {
  load: (): Record<string, TargetMemory> => (existsSync(cfg.STATE_FILE) ? (JSON.parse(readFileSync(cfg.STATE_FILE, "utf8")) as Record<string, TargetMemory>) : {}),
  save: (m: Record<string, TargetMemory>) => {
    writeFileSync(`${cfg.STATE_FILE}.tmp`, JSON.stringify(m));
    renameSync(`${cfg.STATE_FILE}.tmp`, cfg.STATE_FILE);
  },
};
const topup = new TopUp(
  viewer,
  treasury,
  minter,
  cfg.deployment,
  [...cfg.targets, ...cfg.usdcTargets],
  { floor: cfg.TREASURY_FLOOR_NEAR, low: cfg.TREASURY_LOW_NEAR, cooldownMs: cfg.COOLDOWN_SEC * 1000, dailyCapNear: cfg.DAILY_CAP_NEAR, dailyCapUsdc: cfg.dailyCapUsdc, dryRun: cfg.DRY_RUN === "on" },
  store,
  log,
);

let stopped = false;
void (async () => {
  while (!stopped) {
    await topup.check();
    await Bun.sleep(cfg.CHECK_INTERVAL_SEC * 1000);
  }
})();

const app = new Hono();
app.get("/live", (c) => c.json({ live: true }));
app.get("/health", async (c) => {
  const r = topup.report();
  const wallet = await walletHealth(viewer, "Treasury", treasury.accountId, { min: cfg.TREASURY_FLOOR_NEAR });
  const checked = topup.lastCheck !== null && topup.lastCheck.error === null && Date.now() / 1000 - topup.lastCheck.at < cfg.CHECK_INTERVAL_SEC * 5;
  const failing = r.targets.filter((t) => t.state === "failing");
  const alerts: Record<string, string> = {};
  if (r.treasury.low) alerts.treasury = `the treasury holds ${r.treasury.balance} NEAR; refill ${treasury.accountId}`;
  for (const t of failing) alerts[t.name] = "refills are failing";
  const ok = checked && failing.length === 0;
  return c.json(
    {
      ok,
      service: "topup",
      network: cfg.NEAR_NETWORK,
      dryRun: cfg.DRY_RUN === "on",
      ...r,
      wallets: [wallet],
      alerts,
      lastError: topup.lastCheck?.error ?? null,
      lastWorkAt: topup.lastCheck?.at ?? null,
      facts: [
        ...(topup.lastCheck ? [{ label: "Last check", at: topup.lastCheck.at }] : []),
        { label: "Treasury", value: `${r.treasury.balance ?? "?"} NEAR`, tone: r.treasury.low ? "bad" : "ok" },
        ...(r.treasury.runwayDays !== null ? [{ label: "Runway", value: `${r.treasury.runwayDays.toFixed(1)} days`, tone: r.treasury.runwayDays < 7 ? "warn" : undefined }] : []),
        ...(cfg.DRY_RUN === "on" ? [{ label: "Dry run", value: "on", tone: "warn" }] : []),
      ],
      flags: cfg.DRY_RUN === "on" ? ["dry run"] : [],
    },
    ok ? 200 : 503,
  );
});
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
log({ port: server.port, network: cfg.NEAR_NETWORK, treasury: treasury.accountId, targets: topup.targets.map((t) => t.name) }, "top-up listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    server.stop();
    process.exit(0);
  });
}
