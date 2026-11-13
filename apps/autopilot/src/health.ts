import type { WalletHealth } from "@tredio/chain";
import { Hono } from "hono";
import type { ExecutorDb } from "./db";
import type { ExecutorStatus } from "./executor";
import type { WalletCheck } from "./wallets";

/** A session call attaches 300 Tgas, which a gas key prepays at 1e9 yocto per gas: 0.3 NEAR. */
export const SESSION_CALL_GAS_NEAR = 0.3;
/** Warn this long before the bot's session ends, so it is renewed (one passkey request) before the bot stops. */
export const BOT_SESSION_WARN_SEC = 3 * 86_400;

export interface HealthDeps {
  status: () => ExecutorStatus;
  stats: ExecutorDb["stats"];
  /** The bot account with its session gas key, or null without a bot. */
  wallet: () => Promise<WalletHealth | null>;
  /** When the bot's session ends on chain (unix seconds), or null without a bot or session. Sessions last 30 days at most. */
  botSessionExpiresAt?: () => Promise<number | null>;
  /** The last check of each policy wallet the executor trades through (OutLayer custody or Agent API agents). */
  policyWallets?: () => WalletCheck[];
  network: string;
  /** When the process started (unix seconds). */
  startedAt?: number;
  tickSec: number;
  /** The id of the key grants are sealed to, or null when this executor cannot open grants. */
  sealKeyId: string | null;
  now?: () => number;
}

/**
 * GET /health in the shape every Tredio service reports: `ok`, the wallets it sends from (the
 * bot's account and its session gas key), alerts, the last error, when it last did its work, facts
 * for the status page and flags that degrade it (the kill switch). `policyWallets` lists the policy
 * wallets that sign accounts' session calls, each with its freeze, its gas and why it waits.
 */
export async function healthReport(d: HealthDeps): Promise<{ httpStatus: 200 | 503; body: Record<string, unknown> }> {
  const nowSec = Math.floor((d.now ?? Date.now)() / 1000);
  const s = d.status();
  const [stats, wallet, botExpiresAt] = await Promise.all([
    d.stats(nowSec).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
    d.wallet().catch(() => null),
    d.botSessionExpiresAt?.().catch(() => undefined),
  ]);
  const alerts: Record<string, string> = {};
  const ticking = s.lastTickAt !== null && nowSec - s.lastTickAt <= d.tickSec * 4;
  if (!ticking) alerts.stale = s.lastTickAt === null ? "no tick yet" : `no tick for ${nowSec - s.lastTickAt}s`;
  if (s.failingTicks >= 3) alerts.ticks = `${s.failingTicks} ticks in a row failed: ${s.lastError ?? "unknown"}`;
  if (!stats.ok) alerts.database = `database unreachable: ${stats.error}`;
  if (stats.ok && stats.v.inFlight > 5) alerts.orders = `${stats.v.inFlight} orders are in flight`;
  if (stats.ok && stats.v.grants > 0 && d.sealKeyId === null) alerts.grants = `${stats.v.grants} active grants, but AUTOPILOT_SEAL_PRIVATE_KEY is not set`;
  const policyWallets = d.policyWallets?.() ?? [];
  const frozenWallets = policyWallets.filter((w) => w.frozen).length;
  const waitingWallets = policyWallets.filter((w) => w.problem !== null).length;
  const gas = wallet?.gasKeys[0];
  if (wallet && (!gas || Number(gas.balance) < SESSION_CALL_GAS_NEAR)) alerts.gas = gas ? `the bot's session gas key holds ${gas.balance} NEAR, below the ${SESSION_CALL_GAS_NEAR} NEAR a session call prepays` : "the bot's session gas key is not on its account";
  // The bot trades only through its session: once it ends, the bot's rules wait and nothing else says why.
  const botExpired = wallet !== null && botExpiresAt !== undefined && (botExpiresAt === null || botExpiresAt <= nowSec);
  if (botExpired) alerts.botSession = botExpiresAt === null ? "the bot's Autopilot session is not on its account" : "the bot's Autopilot session has ended; renew it (add_session with the same key)";
  else if (wallet !== null && typeof botExpiresAt === "number" && botExpiresAt - nowSec < BOT_SESSION_WARN_SEC) alerts.botSession = `the bot's Autopilot session ends in ${Math.ceil((botExpiresAt - nowSec) / 3600)}h; renew it`;
  const ok = ticking && stats.ok && s.failingTicks < 3 && !alerts.gas && !botExpired;
  const flags = [...(s.kill.engaged ? ["kill switch engaged"] : []), ...(d.sealKeyId === null ? ["no seal key: grants cannot trade"] : [])];
  const facts = [
    ...(s.lastTickAt !== null ? [{ label: "Last tick", at: s.lastTickAt }, { label: "Tick took", value: `${s.lastTickMs} ms` }] : []),
    { label: "Kill switch", value: s.kill.engaged ? `engaged${s.kill.reason ? `: ${s.kill.reason}` : ""}` : "off", tone: s.kill.engaged ? "bad" : "ok" },
    ...(stats.ok
      ? [
          { label: "Rules running", value: String(stats.v.rules) },
          { label: "Grants", value: `${stats.v.grants} active` },
          { label: "Follows", value: `${stats.v.follows} active, ${stats.v.leaders} leaders` },
          { label: "Orders in flight", value: String(stats.v.inFlight), tone: stats.v.inFlight > 5 ? "warn" : undefined },
          { label: "Orders today", value: `${stats.v.today.filled} filled, ${stats.v.today.unfilled} unfilled, ${stats.v.today.failed} failed`, tone: stats.v.today.failed > 0 ? "warn" : undefined },
        ]
      : []),
    { label: "Bot", value: wallet ? wallet.account : "not configured", tone: wallet ? undefined : "neutral" },
    ...(policyWallets.length > 0
      ? [{ label: "Policy wallets", value: `${policyWallets.length} in use, ${frozenWallets} frozen by their accounts${waitingWallets > frozenWallets ? `, ${waitingWallets - frozenWallets} waiting` : ""}`, tone: waitingWallets > frozenWallets ? "warn" : undefined }]
      : []),
    { label: "Seal key", value: d.sealKeyId ?? "not set", tone: d.sealKeyId ? undefined : "warn" },
  ];
  return {
    httpStatus: ok ? 200 : 503,
    body: {
      ok,
      service: "autopilot",
      network: d.network,
      startedAt: d.startedAt ?? null,
      wallets: wallet ? [wallet] : [],
      policyWallets,
      alerts,
      lastError: s.lastError,
      lastWorkAt: s.lastTickAt,
      kill: s.kill,
      facts,
      flags,
    },
  };
}

export function healthApp(d: HealthDeps): Hono {
  const app = new Hono();
  // Liveness for the container: the process serves, whatever the database or the chain says.
  app.get("/live", (c) => c.json({ live: true }));
  app.get("/health", async (c) => {
    const r = await healthReport(d);
    return c.json(r.body, r.httpStatus);
  });
  return app;
}
