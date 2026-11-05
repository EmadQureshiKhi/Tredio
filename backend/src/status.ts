import type { ChainReader } from "./chain";

/**
 * The public status view: each service's health endpoint, the oracle's freshness, the chain head
 * and the service fleet's gas keys, as up or down plus balances (the detail stays on each service
 * and behind admin sign-in).
 *
 * Every Tredio service reports one health shape (`ServiceHealth`), so this module reads them all
 * the same way: the NEAR accounts it sends from with their balances and gas keys, the alerts it
 * has raised, its last error and, for the top-up service, the treasury and every account it keeps
 * funded.
 */

export interface ServiceProbe {
  name: string;
  url: string;
  /** Its outage is a warning in the admin system view, not critical. */
  optional?: boolean;
  /** How long it may go without doing its work before the admin system view reads it as stalled (ms). */
  staleMs?: number;
}

/**
 * name=url entries, comma-separated, each optionally followed by |-separated flags for the admin
 * system view: `optional` and `staleMin=<minutes>` (`keeper=http://k/health|staleMin=5`). An
 * entry without a name or an http(s) URL is skipped; an unknown or malformed flag throws, so a
 * typo fails at start-up (loadConfig parses every list once).
 */
export function parseServices(value: string | undefined): ServiceProbe[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [pair = "", ...flags] = entry.split("|").map((f) => f.trim());
      const i = pair.indexOf("=");
      const probe: ServiceProbe = { name: pair.slice(0, i).trim(), url: pair.slice(i + 1).trim() };
      for (const flag of flags.filter(Boolean)) {
        const stale = /^staleMin=(\d+(?:\.\d+)?)$/.exec(flag);
        if (flag === "optional") probe.optional = true;
        else if (stale && Number(stale[1]) > 0) probe.staleMs = Math.round(Number(stale[1]) * 60_000);
        else throw new Error(`service ${probe.name || pair}: unknown flag "${flag}" (use optional or staleMin=<minutes>)`);
      }
      return probe;
    })
    .filter((s) => s.name && /^https?:\/\//.test(s.url));
}

/** A gas key a service signs with: its own prepaid NEAR for gas and its parallel nonces. */
export interface GasKeyDetail {
  publicKey: string;
  /** NEAR, decimal. */
  balance: string;
  nonces: number;
}

/** An account a service sends from, with its NEAR (a decimal string) and gas keys. */
export interface ServiceWallet {
  label: string;
  account: string;
  balance: string | null;
  /** Below this the service reports itself unhealthy (NEAR, decimal). */
  min: string | null;
  gasKeys: GasKeyDetail[];
}

/** The top-up treasury: what it holds, what it keeps back, its burn and runway, and its targets. */
export interface TreasuryDetail {
  account: string;
  balance: string;
  floor: string;
  spendable: string;
  burnPerDay: string | null;
  runwayDays: number | null;
  /** The treasury is below its warning level: ask for a refill. */
  low: boolean;
  targets: Array<{
    name: string;
    account: string;
    balance: string;
    min: string;
    target: string;
    state: string;
    /** NEAR this account burned over the last day; null until the top-up service has a day of history. */
    burnPerDay: string | null;
    lastTransfer: { hash: string | null; amount: string; at: number; status: string } | null;
  }>;
}

/** One service as operators see it: reachability plus what its health endpoint reports. */
export interface ServiceDetail {
  name: string;
  ok: boolean;
  latencyMs: number | null;
  /** The health endpoint's HTTP status; null when it did not answer. */
  httpStatus: number | null;
  lastError: string | null;
  /** Alerts the service has raised and not yet cleared. */
  alerts: string[];
  wallets: ServiceWallet[];
  /** The top-up service only. */
  treasury: TreasuryDetail | null;
  /** When the service last finished its work (unix seconds), if it says. */
  lastWorkAt: number | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isAccount = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9._-]{2,64}$/.test(v);
const decimal = (v: unknown): string | null => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null);
const message = (v: unknown): string | null => str(v) ?? str(obj(v)?.message) ?? str(obj(v)?.error) ?? null;

function walletOf(v: unknown): ServiceWallet | null {
  const w = obj(v);
  if (!w || !isAccount(w.account)) return null;
  const gasKeys = (Array.isArray(w.gasKeys) ? w.gasKeys : []).flatMap((k) => {
    const g = obj(k);
    return g && str(g.publicKey) && decimal(g.balance) ? [{ publicKey: str(g.publicKey)!, balance: decimal(g.balance)!, nonces: num(g.nonces) ?? 1 }] : [];
  });
  return { label: str(w.label) ?? w.account, account: w.account, balance: decimal(w.balance), min: decimal(w.min), gasKeys };
}

/** Reads one service's health body; anything it does not recognize is left out. */
export function describeHealth(body: unknown): Omit<ServiceDetail, "name" | "ok" | "latencyMs" | "httpStatus"> {
  const b = obj(body) ?? {};
  const wallets = (Array.isArray(b.wallets) ? b.wallets : []).flatMap((w) => walletOf(w) ?? []);
  const t = obj(b.treasury);
  let treasury: TreasuryDetail | null = null;
  if (t && isAccount(t.account) && decimal(t.balance) !== null) {
    treasury = {
      account: t.account,
      balance: decimal(t.balance)!,
      floor: decimal(t.floor) ?? "0",
      spendable: decimal(t.spendable) ?? "0",
      burnPerDay: decimal(t.burnPerDay),
      runwayDays: num(t.runwayDays),
      low: t.low === true,
      targets: (Array.isArray(b.targets) ? b.targets : []).flatMap((x) => {
        const g = obj(x);
        if (!g || !isAccount(g.account) || str(g.name) === null) return [];
        const last = obj(g.lastTransfer);
        return [
          {
            name: str(g.name)!,
            account: g.account,
            balance: decimal(g.balance) ?? "0",
            min: decimal(g.min) ?? "0",
            target: decimal(g.target) ?? "0",
            state: str(g.state) ?? "unknown",
            burnPerDay: decimal(g.burnPerDay),
            lastTransfer: last && num(last.at) !== null ? { hash: str(last.hash), amount: decimal(last.amount) ?? "0", at: num(last.at)!, status: str(last.status) ?? "unknown" } : null,
          },
        ];
      }),
    };
  }
  const alerts = Object.entries(obj(b.alerts) ?? {}).map(([k, v]) => (typeof v === "string" && v ? `${k}: ${v}` : k));
  const lastError = message(b.lastError) ?? (b.ok === false ? message(b.error) : null);
  return { lastError, alerts, wallets, treasury, lastWorkAt: num(b.lastWorkAt) };
}

/** Every service's health in detail, for the admin view; never throws. */
export async function serviceDetails(services: readonly ServiceProbe[], fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<ServiceDetail[]> {
  return Promise.all(
    services.map(async (s): Promise<ServiceDetail> => {
      const started = Date.now();
      try {
        const res = await fetchImpl(s.url, { signal: AbortSignal.timeout(3000) });
        const latencyMs = Date.now() - started;
        const body: unknown = await res.json().catch(() => null);
        return { name: s.name, ok: res.ok, latencyMs, httpStatus: res.status, ...describeHealth(body) };
      } catch {
        return { name: s.name, ok: false, latencyMs: null, httpStatus: null, lastError: "no answer", alerts: [], wallets: [], treasury: null, lastWorkAt: null };
      }
    }),
  );
}

/**
 * The public status: up or down for every service, the oracle and the chain head, plus the
 * service fleet (each account a service sends from and its gas keys, all public on chain anyway).
 */
export async function status(
  chain: ChainReader,
  services: readonly ServiceProbe[],
  opts: { oracleStaleSec: number; fetchImpl?: typeof fetch; /** Trends rotating out: stale on purpose. */ rotating?: ReadonlySet<string> },
  nowSec = Math.floor(Date.now() / 1000),
) {
  const details = await serviceDetails(services, opts.fetchImpl);
  let oracle: { ok: boolean; lastRunAgeSec: number | null; staleTrends: number } = { ok: false, lastRunAgeSec: null, staleTrends: 0 };
  let head: { ok: boolean; ageSec: number | null; height: number | null } = { ok: false, ageSec: null, height: null };
  try {
    const [trends, lastRunId, block] = await Promise.all([chain.trends(), chain.lastRunId(), chain.viewer.head()]);
    const live = trends.filter((t) => t.status === "Active" || t.status === "Cooling");
    // Oracle run ids are the report's observation time (unix seconds).
    const lastRunAgeSec = Number(lastRunId) > 0 ? nowSec - Number(lastRunId) : null;
    const staleTrends = live.filter((t) => !opts.rotating?.has(t.identifier) && nowSec - t.updatedAt > opts.oracleStaleSec).length;
    oracle = { ok: lastRunAgeSec !== null && lastRunAgeSec < opts.oracleStaleSec && staleTrends === 0, lastRunAgeSec, staleTrends };
    const ageSec = Math.max(0, nowSec - block.time);
    head = { ok: ageSec < 30, ageSec, height: block.height };
  } catch {
    // Chain unreachable: both stay down.
  }
  const fleet = details.flatMap((s) =>
    s.wallets.map((w) => ({ service: s.name, label: w.label, account: w.account, balance: w.balance, gasKeys: w.gasKeys.map((k) => ({ publicKey: k.publicKey, balance: k.balance, nonces: k.nonces })) })),
  );
  const ok = details.every((p) => p.ok) && oracle.ok && head.ok;
  return { ok, network: chain.deployment.network, services: details.map((s) => ({ name: s.name, ok: s.ok, latencyMs: s.latencyMs })), oracle, chain: head, fleet, at: nowSec };
}
