import { Viewer, walletWatch } from "@tredio/chain";
import { AccountVersions } from "@tredio/contracts";
import { type HlNetwork, HyperliquidInfo, hyperliquidAddressOf } from "@tredio/hyperliquid";
import { loadConfig } from "./config";
import { Copier, hyperliquidLeaders } from "./copier";
import { connect, ExecutorDb } from "./db";
import { type AccountReader, Executor } from "./executor";
import { healthApp } from "./health";
import { jsonLog } from "./log";
import type { RegistryMark } from "./orders";
import { sealPublicKey } from "./seal";
import { AUTOPILOT_POLICY, hyperliquidApi, Nonces, relayerFunding, SessionVenue } from "./venue";
import { nearGrantChain, nearSessionChain, type VenueRequest, Venues } from "./venues";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

const cfg = loadConfig(process.env);
const log = jsonLog("autopilot");
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpc);
const botWallet = cfg.bot ? walletWatch(viewer, "Bot", cfg.bot.account, { gasKeys: [cfg.bot.sessionKey] }) : null;
// The account contract signs for Hyperliquid's network of the same name ("a" mainnet, "b" testnet).
const network: HlNetwork = cfg.NEAR_NETWORK;
const info = new HyperliquidInfo(network);
const hyperliquid = hyperliquidApi(info, network);
const db = new ExecutorDb(connect(cfg.DATABASE_URL));
const nonces = new Nonces();
// Each account's code version (v1 or v2), read once and re-read every ten minutes, so an upgrade
// shows: it sets a session call's gas and the order guard's rules.
const versions = new AccountVersions((account) => viewer.view<number>(account, "version"));

const addresses = new Map<string, Promise<string>>();
/** An account's Hyperliquid address (its Chain Signatures key for path `hyperliquid`); it never changes. */
function addressOf(owner: string): Promise<string> {
  let a = addresses.get(owner);
  if (!a) {
    a = hyperliquidAddressOf((c, m, args) => viewer.view(c, m, args), cfg.deployment.external.chainSignatures, owner);
    addresses.set(owner, a);
    a.catch(() => addresses.delete(owner));
  }
  return a;
}

const makeVenue = (r: VenueRequest) =>
  new SessionVenue({
    owner: r.owner,
    kind: r.kind,
    sessionKey: r.sessionKey,
    network,
    policy: AUTOPILOT_POLICY,
    chain: nearSessionChain(viewer, cfg.deployment, r.owner, r.secretKey, cfg.rpc, versions),
    hyperliquid,
    addressOf: () => addressOf(r.owner),
    nonces,
    fund: relayerFunding(cfg.RELAYER_URL, r.owner, r.sessionKey),
    gasMin: cfg.SESSION_GAS_MIN_NEAR,
  });
const venues = new Venues(db, nearGrantChain(viewer), makeVenue, { sealPrivateKey: cfg.AUTOPILOT_SEAL_PRIVATE_KEY ?? null, bot: cfg.bot }, log);
const reader: AccountReader = { addressOf, state: (a) => hyperliquid.accountState(a), fills: (a) => hyperliquid.fills(a) };
const registryMark = (asset: string) => viewer.view<RegistryMark | null>(cfg.deployment.contracts.registry, "mark_of", { asset });

let copier: Copier | null = null;
const executor = new Executor(
  db,
  () => info.perpMarkets(),
  registryMark,
  venues,
  reader,
  nonces,
  {
    slippageBps: cfg.SLIPPAGE_BPS,
    maxConsecutiveFailures: cfg.MAX_CONSECUTIVE_FAILURES,
    maxAttempts: 5,
    orderStaleSec: 120,
    killEnv: cfg.KILL_SWITCH !== undefined,
    netflowMaxAgeSec: cfg.NETFLOW_MAX_AGE_SEC,
    takerFeeBps: cfg.HL_TAKER_FEE_BPS,
  },
  log,
  async (ctx) => copier?.tick(ctx),
);
// Leaders: the Tredio bot where it trades (from its own account's address), everyone else on mainnet's leaderboard.
const leaders = hyperliquidLeaders({
  network,
  trading: info,
  mainnet: network === "mainnet" ? info : new HyperliquidInfo("mainnet"),
  onTradingNetwork: async (leader) => cfg.bot !== null && leader.toLowerCase() === (await addressOf(cfg.bot.account)).toLowerCase(),
});
copier = new Copier(db, executor, leaders, log, network);

const seal = cfg.AUTOPILOT_SEAL_PRIVATE_KEY ? await sealPublicKey(cfg.AUTOPILOT_SEAL_PRIVATE_KEY) : null;
const server = Bun.serve({
  port: cfg.PORT,
  fetch: healthApp({
    status: () => executor.status,
    stats: (nowSec) => db.stats(nowSec),
    wallet: async () => (botWallet ? botWallet() : null),
    network: cfg.NEAR_NETWORK,
    tickSec: cfg.TICK_SEC,
    sealKeyId: seal?.keyId ?? null,
  }).fetch,
});
log.info(
  {
    port: server.port,
    network: cfg.NEAR_NETWORK,
    bot: cfg.bot ? { account: cfg.bot.account, sessionKey: cfg.bot.sessionKey } : null,
    // The backend's AUTOPILOT_SEAL_PUBLIC_KEY must be this, so the app seals grants to this executor.
    sealPublicKey: seal?.publicKey ?? null,
    sealKeyId: seal?.keyId ?? null,
  },
  seal ? "autopilot listening; set the backend's AUTOPILOT_SEAL_PUBLIC_KEY to sealPublicKey" : "autopilot listening without a seal key: only the bot trades",
);

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try {
    await executor.tick();
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e), failingTicks: executor.status.failingTicks }, "tick failed");
  } finally {
    running = false;
  }
}
const timer = setInterval(loop, cfg.TICK_SEC * 1000);
void loop();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    log.info({ signal }, "stopping");
    clearInterval(timer);
    server.stop();
    await db.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
