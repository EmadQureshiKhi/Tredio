import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Sender, Viewer, walletWatch } from "@tredio/chain";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { Engine, type EngineState } from "./engine";

const cfg = loadConfig(process.env);
const log = (fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ service: "market-maker", msg, ...fields }));
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpc);
const sender = new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.MM_ACCOUNT_ID, privateKey: cfg.MM_PRIVATE_KEY, gasKeyLanes: cfg.MM_GAS_KEY_LANES, rpc: cfg.rpc });
// Order ids live only here: deleting the file strands resting orders until a kill switch or cancel_expired clears them.
const store = {
  load: (): EngineState => (existsSync(cfg.STATE_FILE) ? (JSON.parse(readFileSync(cfg.STATE_FILE, "utf8")) as EngineState) : { orders: {}, series: [], requotedAt: {} }),
  save: (s: EngineState) => {
    writeFileSync(`${cfg.STATE_FILE}.tmp`, JSON.stringify(s));
    renameSync(`${cfg.STATE_FILE}.tmp`, cfg.STATE_FILE);
  },
};
const engine = new Engine(
  sender,
  viewer,
  cfg.deployment,
  {
    windows: cfg.QUOTE_WINDOWS,
    maxSeries: cfg.MAX_SERIES,
    setsPerSeries: cfg.SETS_PER_SERIES,
    marginUsdc: cfg.MARGIN_USDC,
    stopBeforeExpirySec: cfg.STOP_BEFORE_EXPIRY_SEC,
    requoteTicks: cfg.REQUOTE_TICKS,
    minRequoteSec: cfg.MIN_REQUOTE_SEC,
    arbMinEdge: cfg.ARB_MIN_EDGE,
    arbMaxTokens: cfg.ARB_MAX_TOKENS,
    quote: { halfSpread: cfg.HALF_SPREAD, levelStep: cfg.LEVEL_STEP, levels: cfg.LEVELS, levelTokens: cfg.LEVEL_TOKENS, maxSkew: cfg.MAX_SKEW, inventoryLimit: cfg.INVENTORY_LIMIT },
  },
  store,
  log,
);
const killed = () => Boolean(cfg.KILL_SWITCH) || Boolean(cfg.KILL_SWITCH_FILE && existsSync(cfg.KILL_SWITCH_FILE));

let stopped = false;
const loop = async () => {
  while (!stopped) {
    try {
      await engine.tick(killed());
    } catch (e) {
      engine.lastError = e instanceof Error ? e.message.slice(0, 300) : String(e);
      log({ err: engine.lastError }, "tick failed");
    }
    await Bun.sleep(cfg.TICK_SEC * 1000);
  }
};
void loop();

const minBalance = BigInt(Math.round(cfg.MIN_BALANCE_NEAR * 1e6)) * 10n ** 18n;
const app = new Hono();
const makerWallet = walletWatch(viewer, "Market maker", sender.accountId, { min: minBalance, gasKeys: [sender.publicKey] });
app.get("/live", (c) => c.json({ live: true }));
app.get("/health", async (c) => {
  const wallet = await makerWallet();
  const funded = wallet.balance !== null && Number(wallet.balance) >= cfg.MIN_BALANCE_NEAR;
  const ticking = engine.lastTick !== null && Date.now() / 1000 - engine.lastTick.at < cfg.TICK_SEC * 10;
  const ok = funded && ticking;
  return c.json(
    {
      ok,
      service: "market-maker",
      network: cfg.NEAR_NETWORK,
      wallets: [wallet],
      alerts: funded ? {} : { balance: `below ${cfg.MIN_BALANCE_NEAR} NEAR` },
      lastError: engine.lastError,
      lastWorkAt: engine.lastTick?.at ?? null,
      killed: engine.killed,
      facts: [
        ...(engine.lastTick ? [{ label: "Last tick", at: engine.lastTick.at }, { label: "Quoting", value: `${engine.lastTick.quoted} series` }] : []),
        { label: "Kill switch", value: engine.killed ? "engaged" : "off", tone: engine.killed ? "bad" : "ok" },
        ...(engine.equity !== null ? [{ label: "Equity", value: `${engine.equity.toFixed(0)} USDC` }] : []),
      ],
      flags: engine.killed ? ["kill switch engaged"] : [],
    },
    ok ? 200 : 503,
  );
});
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
log({ port: server.port, network: cfg.NEAR_NETWORK, account: sender.accountId, key: sender.publicKey }, "market maker listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    server.stop();
    process.exit(0);
  });
}
