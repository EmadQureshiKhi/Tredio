import type { AiProviderStats } from "./ai/providers";
import type { BenchReason, KeyUsage } from "./budget";
import type { ChainTrend } from "./chain";
import { type ErrorLog, type RecentError, scrub } from "./errors";
import type { IndexedOracle, IndexerProgress } from "./indexer";
import type { KeyCalls, KeyCheck } from "./sources/elfa";
import { maskKey } from "./sources/elfa-proxies";
import type { FallbackStats } from "./sources/proxy-pool";
import type { SourceStat } from "./sources/stats";
import { describeHealth, type ServiceProbe, type ServiceWallet, type TreasuryDetail } from "./status";
import type { SourceName } from "./store";

/**
 * The admin system view (GET /v1/admin/system): every service, the chain and the indexer, the
 * oracle, each Elfa key and its route, the free sources and AI providers, the RPC providers, the
 * wallets, data freshness and recent errors, read in parallel with short timeouts, and a ranked
 * list of what is wrong. It reads what the backend already tracks in memory and each service's
 * own /health; it never spends an Elfa credit. Nothing secret leaves it: keys show as their last
 * four characters, routes as host and port, RPC endpoints as their provider, and a final pass
 * replaces any configured secret that still made it into the text.
 */

export type Severity = "critical" | "warning" | "info";
export type Tone = "ok" | "warn" | "bad" | "neutral";
export type Area = "database" | "chain" | "services" | "oracle" | "indexer" | "rpc" | "elfa" | "wallets" | "ai" | "jobs" | "sources" | "freshness";

export interface Problem {
  severity: Severity;
  area: Area;
  title: string;
  detail?: string;
}

/** One line of a service's health: a value, or a time (`at`, ms) the page shows as an age. */
export interface Fact {
  label: string;
  value?: string;
  at?: number;
  tone?: Tone;
}

export interface RpcEndpoint {
  provider: string;
  requests: number;
  failures: number;
  healthy: boolean;
}

export type ServiceState = "up" | "degraded" | "down";

export interface ServiceReport {
  name: string;
  state: ServiceState;
  /** Whether this service being down is critical (not for one flagged optional in its config). */
  core: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  /** When the service last did its work (its own report), else when it last answered healthy (ms). */
  lastSuccessAt: number | null;
  lastError: string | null;
  alerts: string[];
  facts: Fact[];
  wallets: ServiceWallet[];
  rpc: RpcEndpoint[];
  /** Why the state is not "up", in a few words. */
  reason: string | null;
  /** Read from the backend itself (backend, oracle, indexer) rather than a health endpoint; their problems have their own areas. */
  derived: boolean;
}

export interface GatewayProvider {
  provider: string;
  healthy: boolean;
  reserve: boolean;
  requests: number;
  ok: number;
  errors: number;
  rateLimited: number;
  timeouts: number;
  refused: number;
  avgLatencyMs: number | null;
  /** Units spent since the gateway started. */
  units: number;
  /** The provider's monthly units; null when it has no monthly cap. */
  monthlyUnits: number | null;
  /** Units a month at the pace since the gateway started. */
  projectedMonthUnits: number | null;
  /** projectedMonthUnits as a percentage of monthlyUnits. */
  budgetPct: number | null;
  /** Blocks behind the gateway's head, from the provider's own answers. */
  headLag: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface RpcGatewayReport {
  ok: boolean;
  head: number | null;
  headAgeMs: number | null;
  uptimeSec: number | null;
  receivedPerSec: number | null;
  upstreamPerSec: number | null;
  failures: number | null;
  clients: Record<string, number>;
  providers: GatewayProvider[];
}

export type ElfaKeyState = "ok" | "idle" | "rejected" | "rate-limited" | "quota" | "route-down" | "route-auth" | "error";

export interface ElfaKeyReport {
  /** 1-based position in ELFA_API_KEYS. */
  index: number;
  /** The key's last four characters. */
  key: string;
  /** The key's route, host and port only. */
  route: string;
  state: ElfaKeyState;
  benchedUntil: number | null;
  usedToday: number;
  usedMonth: number;
  /** Credits the pacing allows today (spent and left). */
  allowanceToday: number;
  leftToday: number;
  /** Month's usage at today's pace. */
  projectedMonth: number;
  requests: number;
  failures: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastStatus: number | null;
  plan: string | null;
  /** May ask for trending narratives (a paid plan). */
  narratives: boolean;
  busy: boolean;
}

export interface ElfaReport {
  configured: boolean;
  keys: ElfaKeyReport[];
  /** Keys left out for want of a route (last four characters). */
  skipped: string[];
  /** Routes no key uses (host and port). */
  unusedRoutes: string[];
  limits: { dailyPerKey: number; monthlyPerKey: number };
  totals: { usedToday: number; usedMonth: number; allowanceToday: number; leftToday: number; monthly: number };
  narrativesAvailable: boolean;
  fallback: { capBytes: number; bytes: number; requests: number; month: string; pct: number } | null;
  lastCheck: { at: number; running: boolean; total: number; results: Array<KeyCheckView> } | null;
}

export type KeyCheckView = Omit<KeyCheck, "keyId"> & { index: number; key: string; route: string };

export type SourceState = "ok" | "idle" | "resting" | "failing" | "off";

export interface SourceReport {
  name: string;
  label: string;
  state: SourceState;
  requests: number;
  ok: number;
  errors: number;
  rateLimited: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** The newest reading of this source the collector stored, when it feeds the index. */
  newestReadingAt: number | null;
  readingsLastHour: number | null;
  /** The newest reading is older than three refresh periods. */
  staleReadings: boolean;
  note: string | null;
}

export interface AiReport {
  providers: Array<AiProviderStats & { state: SourceState }>;
  leftToday: number | null;
  dailyCalls: number;
}

export interface JobReport {
  job: string;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  intervalSec: number | null;
  state: "ok" | "failing" | "stale" | "never";
}

/** An account a service sends from, NEAR amounts as decimal strings. */
export interface WalletRow {
  name: string;
  account: string;
  balance: string | null;
  min: string | null;
  target: string | null;
  burnPerDay: string | null;
  /** Gas keys the account signs with, and the NEAR they hold for gas. */
  gasKeys: number;
  gasKeyBalance: string | null;
  state: string | null;
  lastError: string | null;
  /** Where the row comes from: the top-up service's targets, or a service's own health. */
  from: "topup" | "service";
}

export type OverallStatus = "ok" | "degraded" | "critical";

export interface SystemReport {
  at: number;
  status: OverallStatus;
  problems: Problem[];
  database: { ok: boolean; latencyMs: number | null; error: string | null };
  chain: { ok: boolean; network: string; head: number | null; headAt: number | null; headAgeSec: number | null; error: string | null };
  indexer: {
    configured: boolean;
    ok: boolean;
    progressBlock: number | null;
    sourceBlock: number | null;
    lagBlocks: number | null;
    lagSec: number | null;
    eventsProcessed: number | null;
    eventsPerMin: number | null;
    readyAt: number | null;
    error: string | null;
  };
  oracle: {
    ok: boolean;
    lastRunAt: number | null;
    lastRunAgeSec: number | null;
    staleAfterSec: number;
    liveTrends: number | null;
    totalTrends: number | null;
    staleTrends: number | null;
    oldestUpdateAgeSec: number | null;
    retireWindowSec: number | null;
    lastIndexedRun: IndexedOracle["lastRun"];
    lastSettlementAt: number | null;
    settlements24h: number | null;
    error: string | null;
  };
  services: ServiceReport[];
  rpc: { gateway: RpcGatewayReport | null; services: Array<{ service: string; endpoints: RpcEndpoint[] }> };
  elfa: ElfaReport;
  sources: SourceReport[];
  ai: AiReport;
  jobs: JobReport[];
  wallets: { treasury: TreasuryDetail | null; rows: WalletRow[] };
  errors: RecentError[];
}

/**
 * How long Tredio's own services may go without doing their work before they read as stalled (ms).
 * A service's `staleMin` flag in STATUS_SERVICES or ADMIN_SERVICES sets or overrides it.
 */
const STALL_MS: Record<string, number> = {
  keeper: 5 * 60_000,
  "market-maker": 10 * 60_000,
  autopilot: 5 * 60_000,
  topup: 15 * 60_000,
};

/** Indexer lag (seconds) past which it is a warning, then critical. */
export const INDEXER_LAG_WARN_SEC = 60;
export const INDEXER_LAG_BAD_SEC = 600;
/** The chain head is stale past this age. */
export const HEAD_STALE_SEC = 30;
/** Treasury runway under these many days is a warning, then critical (the operations page uses the same). */
export const RUNWAY_WARN_DAYS = 7;
export const RUNWAY_BAD_DAYS = 3;
/** Fallback traffic past this share of the month's cap is a warning. */
const FALLBACK_WARN_PCT = 80;

const TIMEOUT_MS = 3500;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const errText = (e: unknown) => scrub(e instanceof Error ? e.message : String(e), 200);

/** Rejects after `ms`, so one slow dependency never holds the page. */
export function within<T>(p: Promise<T>, ms = TIMEOUT_MS, what = "request"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

const settle = async <T>(p: Promise<T>, ms?: number, what?: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  try {
    return { ok: true, value: await within(p, ms, what) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
};

/** A route URL as host and port only: never its username or password. */
export function egressAddress(route: string): string {
  try {
    const u = new URL(route);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "invalid route";
  }
}

/** An RPC gateway's /health: one endpoint in front of several providers, each with its request stats. */
const isGateway = (b: Json | null): b is Json & { providers: unknown[] } =>
  b !== null && Array.isArray(b.providers) && num(b.upstream) !== null && b.providers.every((p) => obj(p) !== null && typeof obj(p)!.provider === "string" && num(obj(p)!.requests) !== null);

const rpcList = (v: unknown): RpcEndpoint[] =>
  (Array.isArray(v) ? v : []).flatMap((x) => {
    const r = obj(x);
    if (!r || typeof r.provider !== "string") return [];
    return [{ provider: scrub(r.provider, 80), requests: num(r.requests) ?? 0, failures: num(r.failures) ?? 0, healthy: r.healthy !== false }];
  });

const yesNo = (v: boolean) => (v ? "yes" : "no");
const count = (n: number) => n.toLocaleString("en-US");

const TONES = new Set(["ok", "warn", "bad", "neutral"]);

/**
 * What a service's /health says, as facts for the page. Tredio's services report their own facts
 * (`facts: [{ label, value?, at?, tone? }]`, `at` in unix seconds), when they last did their work
 * (`lastWorkAt`, seconds) and anything that degrades them (`flags`), so a new service needs no
 * change here. The RPC gateway is recognized by its shape.
 */
export function serviceFacts(body: unknown, nowMs: number): { facts: Fact[]; lastWorkAt: number | null; flags: string[] } {
  const b = obj(body) ?? {};
  const facts: Fact[] = (Array.isArray(b.facts) ? b.facts : []).flatMap((x): Fact[] => {
    const f = obj(x);
    const label = str(f?.label);
    if (!f || !label) return [];
    const at = num(f.at);
    const tone = typeof f.tone === "string" && TONES.has(f.tone) ? (f.tone as Tone) : undefined;
    const value = str(f.value);
    return [{ label: scrub(label, 60), ...(value !== null ? { value: scrub(value, 120) } : {}), ...(at !== null ? { at: at < 1e12 ? at * 1000 : at } : {}), ...(tone ? { tone } : {}) }];
  });
  const flags = (Array.isArray(b.flags) ? b.flags : []).flatMap((f) => (typeof f === "string" && f ? [scrub(f, 80)] : []));
  const work = num(b.lastWorkAt);
  let lastWorkAt = work !== null ? (work < 1e12 ? work * 1000 : work) : null;
  if (isGateway(b)) {
    const age = num(b.headAgeMs);
    lastWorkAt = age !== null ? nowMs - age : null;
    if (num(b.head) !== null) facts.push({ label: "Head", value: `#${count(num(b.head)!)}`, tone: age !== null && age > 30_000 ? "warn" : undefined });
    const providers = b.providers.map(obj);
    const healthy = providers.filter((p) => p?.healthy === true).length;
    facts.push({ label: "Providers healthy", value: `${healthy} of ${providers.length}`, tone: healthy === 0 ? "bad" : healthy < providers.length ? "warn" : "ok" });
    if (num(b.receivedPerSec) !== null) facts.push({ label: "Load", value: `${num(b.receivedPerSec)!.toFixed(1)} req/s in, ${(num(b.upstreamPerSec) ?? 0).toFixed(1)} upstream` });
    if (num(b.failures) !== null) facts.push({ label: "Failed calls", value: count(num(b.failures)!), tone: num(b.failures)! > 0 ? "warn" : undefined });
  }
  return { facts, lastWorkAt, flags };
}

/** An RPC gateway's /health, with each provider's monthly units projected at the pace since it started. */
export function gatewayReport(body: unknown, nowMs: number): RpcGatewayReport | null {
  const b = obj(body);
  if (!isGateway(b)) return null;
  const uptime = num(b.uptimeSec);
  const head = num(b.head);
  // A projection from minutes of traffic says little; it needs ten minutes at least.
  const scale = uptime !== null && uptime >= 600 ? (30 * 86_400) / uptime : null;
  const providers = b.providers.flatMap((x): GatewayProvider[] => {
    const p = obj(x);
    if (!p || typeof p.provider !== "string") return [];
    const units = num(p.units) ?? 0;
    const monthly = num(p.monthlyUnits);
    const projected = scale !== null && monthly ? Math.round(units * scale) : null;
    const ago = num(p.lastErrorAgoSec);
    const providerHead = num(p.head);
    return [
      {
        provider: scrub(p.provider, 80),
        healthy: p.healthy === true,
        reserve: p.reserve === true,
        requests: num(p.requests) ?? 0,
        ok: num(p.ok) ?? 0,
        errors: num(p.errors) ?? 0,
        rateLimited: num(p.rateLimited) ?? 0,
        timeouts: num(p.timeouts) ?? 0,
        refused: num(p.refused) ?? 0,
        avgLatencyMs: num(p.avgLatencyMs),
        units,
        monthlyUnits: monthly,
        projectedMonthUnits: projected,
        budgetPct: projected !== null && monthly ? Math.round((projected / monthly) * 1000) / 10 : null,
        headLag: head !== null && providerHead !== null && providerHead > 0 ? Math.max(0, head - providerHead) : null,
        lastError: str(p.lastError) ? scrub(String(p.lastError), 200) : null,
        lastErrorAt: ago !== null ? nowMs - ago * 1000 : null,
      },
    ];
  });
  const clients = Object.fromEntries(Object.entries(obj(b.clients) ?? {}).flatMap(([k, v]) => (num(v) !== null ? [[scrub(k, 40), num(v)!]] : [])));
  return {
    ok: b.ok === true,
    head,
    headAgeMs: num(b.headAgeMs),
    uptimeSec: uptime,
    receivedPerSec: num(b.receivedPerSec),
    upstreamPerSec: num(b.upstreamPerSec),
    failures: num(b.failures),
    clients,
    providers,
  };
}

const elfaStateOf = (bench: { reason: BenchReason } | undefined, calls: KeyCalls): ElfaKeyState => {
  if (bench) return bench.reason === "throttled" ? "rate-limited" : bench.reason;
  if (calls.requests === 0) return "idle";
  if (calls.lastErrorAt !== null && (calls.lastOkAt === null || calls.lastErrorAt > calls.lastOkAt) && calls.lastOutcome === "error") return "error";
  return "ok";
};

/** Days in the month and the day of the month (UTC), for pacing projections. */
function monthPace(nowMs: number): { day: number; days: number } {
  const d = new Date(nowMs);
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return { day: d.getUTCDate() - 1 + (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60) / 86_400, days };
}

export interface ElfaInputs {
  routes: ReadonlyArray<{ key: string; keyId: string; proxy: string }>;
  skipped: readonly string[];
  unusedRoutes: readonly string[];
  usage: KeyUsage[];
  benches: Array<{ keyId: string; until: number; reason: BenchReason }>;
  calls: KeyCalls[];
  busy: ReadonlySet<string>;
  narrativesAllowed: (keyId: string) => boolean;
  narrativesAvailable: boolean;
}

export function elfaReport(
  e: ElfaInputs | null,
  nowMs: number,
  limits: { dailyPerKey: number; monthlyPerKey: number },
  fallback: FallbackStats | null,
  lastCheck: { at: number; results: KeyCheck[]; running?: boolean } | null = null,
): ElfaReport {
  const fallbackView = fallback && fallback.capBytes > 0 ? { ...fallback, pct: Math.round((fallback.bytes / fallback.capBytes) * 1000) / 10 } : null;
  if (!e) {
    return { configured: false, keys: [], skipped: [], unusedRoutes: [], limits, totals: { usedToday: 0, usedMonth: 0, allowanceToday: 0, leftToday: 0, monthly: 0 }, narrativesAvailable: false, fallback: fallbackView, lastCheck: null };
  }
  const pace = monthPace(nowMs);
  const index = new Map(e.routes.map((r, i) => [r.keyId, i]));
  const keys = e.routes.map((r, i): ElfaKeyReport => {
    const u = e.usage.find((x) => x.keyId === r.keyId) ?? { keyId: r.keyId, today: 0, month: 0, left: 0 };
    const calls = e.calls.find((c) => c.keyId === r.keyId) ?? { keyId: r.keyId, requests: 0, ok: 0, failures: 0, lastOkAt: null, lastErrorAt: null, lastError: null, lastStatus: null, lastOutcome: null, check: null };
    const bench = e.benches.find((b) => b.keyId === r.keyId);
    return {
      index: i + 1,
      key: maskKey(r.key),
      route: egressAddress(r.proxy),
      state: elfaStateOf(bench, calls),
      benchedUntil: bench?.until ?? null,
      usedToday: u.today,
      usedMonth: u.month,
      allowanceToday: u.today + u.left,
      leftToday: bench ? 0 : u.left,
      projectedMonth: pace.day > 0.5 ? Math.round((u.month / pace.day) * pace.days) : u.month,
      requests: calls.requests,
      failures: calls.failures,
      lastOkAt: calls.lastOkAt,
      lastErrorAt: calls.lastErrorAt,
      lastError: calls.lastError,
      lastStatus: calls.lastStatus,
      plan: calls.check?.plan ?? null,
      narratives: e.narrativesAllowed(r.keyId),
      busy: e.busy.has(r.proxy),
    };
  });
  const sum = (f: (k: ElfaKeyReport) => number) => keys.reduce((a, k) => a + f(k), 0);
  return {
    configured: true,
    keys,
    skipped: [...e.skipped],
    unusedRoutes: e.unusedRoutes.map(egressAddress),
    limits,
    totals: { usedToday: sum((k) => k.usedToday), usedMonth: sum((k) => k.usedMonth), allowanceToday: sum((k) => k.allowanceToday), leftToday: sum((k) => k.leftToday), monthly: keys.length * limits.monthlyPerKey },
    narrativesAvailable: e.narrativesAvailable,
    fallback: fallbackView,
    lastCheck: lastCheck
      ? {
          at: lastCheck.at,
          running: lastCheck.running ?? false,
          total: e.routes.length,
          results: lastCheck.results.map(({ keyId, ...c }) => {
            const i = index.get(keyId) ?? -1;
            const route = e.routes[i];
            return { ...c, index: i + 1, key: route ? maskKey(route.key) : "?", route: route ? egressAddress(route.proxy) : "?" };
          }),
        }
      : null,
  };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const AREA_RANK: Area[] = ["database", "chain", "services", "oracle", "indexer", "rpc", "wallets", "elfa", "ai", "jobs", "sources", "freshness"];

/** Problems most severe first, then by how central their area is. */
export function rankProblems(problems: readonly Problem[]): Problem[] {
  return [...problems].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || AREA_RANK.indexOf(a.area) - AREA_RANK.indexOf(b.area) || a.title.localeCompare(b.title));
}

export function overallStatus(problems: readonly Problem[]): OverallStatus {
  if (problems.some((p) => p.severity === "critical")) return "critical";
  if (problems.some((p) => p.severity === "warning")) return "degraded";
  return "ok";
}

const ageText = (sec: number) => (sec < 90 ? `${Math.round(sec)}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : sec < 172_800 ? `${(sec / 3600).toFixed(1)}h` : `${Math.round(sec / 86_400)}d`);
const nearText = (v: string | null) => (v === null ? "?" : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) >= 100 ? 0 : 2 })} NEAR`);

/** Everything wrong in a report, ranked: the top of the page. */
export function findProblems(r: Omit<SystemReport, "problems" | "status">): Problem[] {
  const out: Problem[] = [];
  const add = (severity: Severity, area: Area, title: string, detail?: string) => out.push(detail ? { severity, area, title, detail } : { severity, area, title });
  const nowSec = r.at / 1000;

  if (!r.database.ok) add("critical", "database", "The database is not answering", r.database.error ?? undefined);
  if (!r.chain.ok) add("critical", "chain", "The chain cannot be read", r.chain.error ?? undefined);
  else if (r.chain.headAgeSec !== null && r.chain.headAgeSec > HEAD_STALE_SEC) add("warning", "chain", `The chain head is ${ageText(r.chain.headAgeSec)} old`, "The RPC endpoints the backend reads may be lagging.");

  for (const s of r.services) {
    if (s.derived) continue;
    if (s.state === "down") add(s.core ? "critical" : "warning", "services", `${s.name} is down`, s.reason ?? s.lastError ?? undefined);
    else if (s.state === "degraded") add("warning", "services", `${s.name} needs attention`, s.reason ?? undefined);
    for (const a of s.alerts) add("warning", "services", `${s.name}: ${a}`);
  }

  const o = r.oracle;
  if (o.error && o.lastRunAgeSec === null) add("critical", "oracle", "The oracle's state cannot be read", o.error);
  else if (o.lastRunAgeSec === null) add("critical", "oracle", "The oracle has never reported");
  else if (o.lastRunAgeSec > o.staleAfterSec) {
    const toRetire = o.retireWindowSec !== null && o.oldestUpdateAgeSec !== null ? o.retireWindowSec - o.oldestUpdateAgeSec : null;
    add("critical", "oracle", `The oracle last reported ${ageText(o.lastRunAgeSec)} ago`, toRetire !== null ? `Live trends retire for good in about ${ageText(Math.max(0, toRetire))} without a report.` : undefined);
  }
  if ((o.staleTrends ?? 0) > 0) add("critical", "oracle", `${o.staleTrends} live ${o.staleTrends === 1 ? "trend has" : "trends have"} a stale index`, o.oldestUpdateAgeSec !== null ? `The oldest update is ${ageText(o.oldestUpdateAgeSec)} old.` : undefined);

  const ix = r.indexer;
  if (ix.configured) {
    if (!ix.ok && ix.error) add("critical", "indexer", "The indexer's progress cannot be read", ix.error);
    else if (ix.lagSec !== null && ix.lagSec > INDEXER_LAG_BAD_SEC) add("critical", "indexer", `The indexer is ${ageText(ix.lagSec)} behind the chain`, ix.lagBlocks !== null ? `${count(ix.lagBlocks)} blocks behind.` : undefined);
    else if (ix.lagSec !== null && ix.lagSec > INDEXER_LAG_WARN_SEC) add("warning", "indexer", `The indexer is ${ageText(ix.lagSec)} behind the chain`, ix.lagBlocks !== null ? `${count(ix.lagBlocks)} blocks behind.` : undefined);
  }

  const gateway = r.rpc.gateway;
  if (gateway) {
    const down = gateway.providers.filter((p) => !p.healthy && !p.reserve);
    const active = gateway.providers.filter((p) => !p.reserve);
    if (active.length > 0 && down.length === active.length) add("critical", "rpc", "Every RPC gateway provider is failing");
    else if (down.length > 0) add("warning", "rpc", `${down.length} of ${active.length} RPC gateway ${active.length === 1 ? "provider is" : "providers are"} failing`, down.map((p) => `${p.provider}${p.lastError ? ` (${p.lastError})` : ""}`).join("; "));
    for (const p of gateway.providers) if (p.budgetPct !== null && p.budgetPct > 100) add("warning", "rpc", `${p.provider} is on pace for ${Math.round(p.budgetPct)}% of its free monthly units`);
  }
  for (const s of r.rpc.services) {
    const bad = s.endpoints.filter((e) => !e.healthy);
    if (bad.length > 0 && bad.length === s.endpoints.length) add("critical", "rpc", `Every RPC endpoint of ${s.service} is failing`, bad.map((e) => e.provider).join(", "));
    else if (bad.length > 0) add("warning", "rpc", `${s.service}: ${bad.map((e) => e.provider).join(", ")} failing`);
  }

  const t = r.wallets.treasury;
  if (t?.runwayDays !== null && t?.runwayDays !== undefined) {
    if (t.runwayDays < RUNWAY_BAD_DAYS) add("critical", "wallets", `The treasury has ${t.runwayDays.toFixed(1)} days of NEAR left`, `Refill ${t.account}.`);
    else if (t.runwayDays < RUNWAY_WARN_DAYS) add("warning", "wallets", `The treasury has ${t.runwayDays.toFixed(1)} days of NEAR left`, `Refill ${t.account}.`);
  }
  if (t?.low && (t.runwayDays === null || t.runwayDays >= RUNWAY_WARN_DAYS)) add("warning", "wallets", `The treasury is low: ${nearText(t.balance)}`, `Refill ${t.account}.`);
  for (const w of r.wallets.rows) {
    if (w.state === "halted") add("critical", "wallets", `Top-ups to ${w.name} are halted`, w.lastError ?? undefined);
    else if (w.state === "failing") add("warning", "wallets", `Top-ups to ${w.name} are failing`, w.lastError ?? undefined);
    if (w.balance !== null && w.min !== null && Number(w.balance) < Number(w.min)) add("warning", "wallets", `${w.name} holds ${nearText(w.balance)}, under its ${nearText(w.min)} minimum`);
  }

  const e = r.elfa;
  if (e.configured) {
    const out_ = e.keys.filter((k) => k.state !== "ok" && k.state !== "idle");
    if (e.keys.length > 0 && out_.length === e.keys.length) add("critical", "elfa", "Every Elfa key is out of service", "The radar and collector cannot read Elfa until one recovers.");
    for (const k of e.keys) {
      const who = `Elfa key ${k.index} (${k.key}, via ${k.route})`;
      if (k.state === "rejected") add("warning", "elfa", `${who} was rejected${k.lastStatus ? ` (${k.lastStatus})` : ""}`, k.lastError ?? undefined);
      else if (k.state === "route-auth") add("warning", "elfa", `${who}: its route refused the credentials`, k.lastError ?? undefined);
      else if (k.state === "route-down") add("warning", "elfa", `${who}: its route is not answering`, k.lastError ?? undefined);
      else if (k.state === "error") add("warning", "elfa", `${who} is failing`, k.lastError ?? undefined);
      else if (k.state === "quota") add("info", "elfa", `${who} is out of credits until tomorrow`);
      else if (k.state === "rate-limited") add("info", "elfa", `${who} is resting after a rate limit`);
    }
    if (e.skipped.length > 0) add("warning", "elfa", `${e.skipped.length} Elfa ${e.skipped.length === 1 ? "key has" : "keys have"} no route and ${e.skipped.length === 1 ? "is" : "are"} not used`, e.skipped.join(", "));
  }
  if (e.fallback && e.fallback.pct >= FALLBACK_WARN_PCT) add("warning", "elfa", `Keyless fallback routes have used ${Math.round(e.fallback.pct)}% of this month's bandwidth`);

  if (r.ai.providers.length === 0) add("critical", "ai", "No AI provider is configured", "The radar cannot assess signals.");
  else if (r.ai.providers.every((p) => p.state === "resting" || p.state === "failing")) add("warning", "ai", "Every AI provider is resting or failing", r.ai.providers.map((p) => p.lastError).filter(Boolean).join("; ") || undefined);
  if (r.ai.leftToday === 0) add("warning", "ai", "Today's AI budget is spent");

  for (const j of r.jobs) {
    if (j.state === "failing") add("warning", "jobs", `The ${j.job} job's last run failed`, j.lastError ?? undefined);
    else if (j.state === "stale") add("warning", "jobs", `The ${j.job} job last finished ${j.lastOkAt ? ageText(nowSec - j.lastOkAt / 1000) : "never"} ago`);
  }

  for (const s of r.sources) {
    if (s.state === "failing") add("warning", "sources", `${s.label} is failing`, s.lastError ?? undefined);
    else if (s.state === "resting") add("info", "sources", `${s.label} is resting after rate limiting`);
    // Readings only matter while trends are live; Nansen measures crypto trends alone.
    if (s.staleReadings && (r.oracle.liveTrends ?? 0) > 0 && s.newestReadingAt !== null) {
      add(s.name === "nansen" ? "info" : "warning", "freshness", `${s.label}'s newest reading is ${ageText(nowSec - s.newestReadingAt / 1000)} old`, s.note ?? undefined);
    }
  }

  return rankProblems(out);
}

/** Replaces every configured secret (and its URL-encoded form) left anywhere in the report's text. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const list = [...new Set(secrets.flatMap((s) => [s, encodeURIComponent(s)]).filter((s) => s.length >= 8))].sort((a, b) => b.length - a.length);
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      for (const s of list) if (out.includes(s)) out = out.split(s).join("[redacted]");
      return out;
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return clean(value) as T;
}

/**
 * The secrets a configuration holds, for redactSecrets: API keys, route URLs with each part of
 * their credentials, RPC URLs and their long path and query parts (where providers put keys), and
 * the database URLs.
 */
export function secretsOf(values: { keys: readonly (string | undefined | null)[]; routes: readonly string[]; urls: readonly (string | undefined | null)[] }): string[] {
  const out: string[] = [];
  for (const k of values.keys) if (k) out.push(k);
  for (const p of values.routes) {
    out.push(p);
    try {
      const u = new URL(p);
      if (u.password) out.push(decodeURIComponent(u.password), u.password);
      if (u.username && u.password) out.push(`${u.username}:${u.password}`);
    } catch {
      /* an invalid route is refused at start-up */
    }
  }
  for (const url of values.urls) {
    if (!url) continue;
    out.push(url);
    try {
      const u = new URL(url);
      if (u.password) out.push(u.password, decodeURIComponent(u.password));
      for (const part of `${u.pathname}${u.search}`.split(/[/?=&]/)) if (part.length >= 16) out.push(part);
    } catch {
      /* not a URL */
    }
  }
  return out;
}

export interface SystemDeps {
  network: string;
  services: readonly ServiceProbe[];
  oracleStaleSec: number;
  /** Collector, radar and history cadences, for stale jobs. */
  jobIntervals: Record<string, number>;
  /** Each source's shortest refresh, for stale readings. */
  refreshSec: Partial<Record<SourceName, number>>;
  store: {
    ping(): Promise<void>;
    jobs(): Promise<Array<{ job: string; lastOkAt: Date | null; lastError: string | null; lastErrorAt: Date | null; lastReport: Record<string, unknown> }>>;
    readingFreshness(nowSec: number): Promise<Array<{ source: SourceName; newestAt: number | null; lastHour: number }>>;
  };
  chain: {
    trends(): Promise<ChainTrend[]>;
    lastRunId(): Promise<bigint>;
    staleRetireWindow(): Promise<number>;
    viewer: { head(): Promise<{ height: number; time: number }> };
  };
  /** The backend's own RPC endpoints' health (the URLs stay here; only providers are reported). */
  rpcReport?: () => RpcEndpoint[];
  /** On-chain identifiers being rotated out: their index goes stale on purpose, so they are not counted stale. */
  rotating?: () => Promise<ReadonlySet<string>>;
  indexer: { progress(): Promise<IndexerProgress | null>; oracle(nowSec?: number): Promise<IndexedOracle> } | null;
  elfa: (() => Promise<ElfaInputs>) | null;
  elfaLimits: { dailyPerKey: number; monthlyPerKey: number };
  fallback: (() => FallbackStats) | null;
  sources: { stats(): SourceStat[]; resting: Record<string, () => boolean>; configured: Record<string, boolean> };
  ai: { report(): AiProviderStats[]; leftToday: (() => Promise<number>) | null; dailyCalls: number };
  errors: ErrorLog;
  secrets: readonly string[];
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  startedAt?: number;
}

const SOURCE_LABELS: Record<string, string> = {
  elfa: "Elfa",
  nansen: "Nansen",
  wikipedia: "Wikipedia",
  gdelt: "GDELT",
  bluesky: "Bluesky",
  hn: "Hacker News",
  coingecko: "CoinGecko",
  geckoterminal: "GeckoTerminal",
};
const SOURCE_ORDER = ["elfa", "wikipedia", "gdelt", "bluesky", "hn", "nansen", "coingecko", "geckoterminal"];

/** A source fails when its last error is newer than its last success and recent. */
const failing = (lastOkAt: number | null, lastErrorAt: number | null, nowMs: number) => lastErrorAt !== null && (lastOkAt === null || lastErrorAt > lastOkAt) && nowMs - lastErrorAt < 3_600_000;

/** Builds the system report; keeps a little state between reports (last healthy probes, event rate). */
export class SystemMonitor {
  private readonly lastOk = new Map<string, number>();
  private events: { at: number; processed: number } | null = null;
  private cache: { at: number; report: SystemReport } | null = null;
  private building: Promise<SystemReport> | null = null;
  private keyCheck: { at: number; results: KeyCheck[]; running: boolean } | null = null;

  constructor(private readonly d: SystemDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** The newest manual key check's results so far, shown until the next one. */
  noteKeyCheck(results: KeyCheck[], opts: { running?: boolean } = {}): void {
    this.keyCheck = { at: this.now(), results, running: opts.running ?? false };
    this.cache = null;
  }

  get lastKeyCheck() {
    return this.keyCheck;
  }

  /** The report, built at most every `maxAgeMs` however many admins are looking. */
  async report(maxAgeMs = 5000): Promise<SystemReport> {
    if (this.cache && this.now() - this.cache.at < maxAgeMs) return this.cache.report;
    this.building ??= this.build().finally(() => {
      this.building = null;
    });
    const report = await this.building;
    this.cache = { at: this.now(), report };
    return report;
  }

  private async probe(s: ServiceProbe): Promise<{ status: number | null; latencyMs: number | null; body: unknown; error: string | null }> {
    const started = Date.now();
    try {
      const res = await within((this.d.fetchImpl ?? fetch)(s.url, { signal: AbortSignal.timeout(TIMEOUT_MS) }), TIMEOUT_MS + 200, s.name);
      const latencyMs = Date.now() - started;
      const body: unknown = await res.json().catch(() => null);
      return { status: res.status, latencyMs, body, error: null };
    } catch (e) {
      return { status: null, latencyMs: null, body: null, error: /timed out|timeout|abort/i.test(String(e)) ? "no answer within 3.5 s" : "no answer (connection refused or unreachable)" };
    }
  }

  async build(): Promise<SystemReport> {
    const d = this.d;
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);

    const [db, head, trends, lastRun, retire, progress, indexed, jobs, freshness, probes, elfaIn, aiLeft] = await Promise.all([
      (async () => {
        const t = Date.now();
        const r = await settle(d.store.ping(), TIMEOUT_MS, "database");
        return { ...r, latencyMs: r.ok ? Date.now() - t : null };
      })(),
      settle(d.chain.viewer.head(), TIMEOUT_MS, "chain head"),
      settle(d.chain.trends(), TIMEOUT_MS + 1500, "trends"),
      settle(d.chain.lastRunId(), TIMEOUT_MS + 1500, "oracle run"),
      settle(d.chain.staleRetireWindow(), TIMEOUT_MS, "retire window"),
      d.indexer ? settle(d.indexer.progress(), TIMEOUT_MS, "indexer progress") : Promise.resolve(null),
      d.indexer ? settle(d.indexer.oracle(nowSec), TIMEOUT_MS, "indexer oracle") : Promise.resolve(null),
      settle(d.store.jobs(), TIMEOUT_MS, "jobs"),
      settle(d.store.readingFreshness(nowSec), TIMEOUT_MS, "readings"),
      Promise.all(d.services.map(async (s) => ({ s, p: await this.probe(s) }))),
      d.elfa ? settle(d.elfa(), TIMEOUT_MS, "elfa usage") : Promise.resolve(null),
      d.ai.leftToday ? settle(d.ai.leftToday(), TIMEOUT_MS, "ai budget") : Promise.resolve(null),
    ]);

    // Chain and oracle.
    const headBlock = head.ok ? { number: head.value.height, at: head.value.time * 1000 } : null;
    const chain = {
      ok: head.ok,
      network: d.network,
      head: headBlock?.number ?? null,
      headAt: headBlock?.at ?? null,
      headAgeSec: headBlock ? Math.max(0, Math.round((nowMs - headBlock.at) / 1000)) : null,
      error: head.ok ? null : head.error,
    };
    const live = trends.ok ? trends.value.filter((t) => t.status === "Active" || t.status === "Cooling") : null;
    const rotatingOut = d.rotating ? await d.rotating().catch(() => new Set<string>()) : new Set<string>();
    const measured = live ? live.filter((t) => !rotatingOut.has(t.identifier)) : null;
    const lastRunAt = lastRun.ok && lastRun.value > 0n ? Number(lastRun.value) * 1000 : null;
    const oldest = measured && measured.length > 0 ? Math.min(...measured.map((t) => t.updatedAt)) : null;

    // Services: each probe, then the backend itself.
    const services: ServiceReport[] = [];
    let gatewayBody: { name: string; body: Json } | null = null;
    let topupBody: unknown = null;
    let keeperOracle: Json | null = null;
    const serviceRpc: Array<{ service: string; endpoints: RpcEndpoint[] }> = [];
    for (const { s, p } of probes) {
      const body = obj(p.body);
      const health = describeHealth(p.body);
      const { facts, lastWorkAt, flags } = serviceFacts(p.body, nowMs);
      const up = p.status !== null && p.status >= 200 && p.status < 300;
      if (up) this.lastOk.set(s.name, nowMs);
      if (isGateway(body)) gatewayBody ??= { name: s.name, body };
      if (body && obj(body.treasury)) topupBody = body;
      if (body && s.name === "keeper") keeperOracle = obj(body.oracle);
      const rpc = rpcList(body?.rpc);
      if (rpc.length > 0) serviceRpc.push({ service: s.name, endpoints: rpc });
      const lastSuccessAt = lastWorkAt ?? this.lastOk.get(s.name) ?? null;
      const stall = s.staleMs ?? STALL_MS[s.name];
      const stalled = up && stall !== undefined && lastWorkAt !== null && nowMs - lastWorkAt > stall;
      const lastError = health.lastError ? scrub(health.lastError, 200) : null;
      const alerts = health.alerts.map((a) => scrub(a, 200));
      let state: ServiceState = up ? "up" : "down";
      let reason: string | null = null;
      if (!up) reason = p.status === null ? (p.error ?? "no answer") : `health answered HTTP ${p.status}${lastError ? `: ${lastError}` : ""}`;
      else if (stalled) {
        state = "degraded";
        reason = `no work for ${ageText((nowMs - lastWorkAt!) / 1000)}`;
      } else if (flags.length > 0) {
        state = "degraded";
        reason = flags.join(", ");
      } else if (lastError) {
        state = "degraded";
        reason = `last error: ${lastError}`;
      }
      if (lastError) d.errors.seen(s.name, lastError);
      for (const a of alerts) d.errors.seen(s.name, a);
      // Errors a service reports per worker (a `workers` map) or per top-up target.
      for (const [handle, t] of Object.entries(obj(body?.workers) ?? {})) {
        const e = str(obj(t)?.lastError);
        if (e) d.errors.seen(s.name, `${handle}: ${e}`);
      }
      for (const t of Array.isArray(body?.targets) ? body.targets : []) {
        const e = str(obj(t)?.lastError);
        if (e) d.errors.seen(s.name, `${str(obj(t)?.name) ?? "target"}: ${e}`);
      }
      services.push({ name: s.name, state, core: s.optional !== true, httpStatus: p.status, latencyMs: p.latencyMs, lastSuccessAt, lastError, alerts, facts, wallets: health.wallets, rpc, reason, derived: false });
    }
    const ownRpc = rpcList(d.rpcReport?.() ?? []);
    if (ownRpc.length > 0) serviceRpc.unshift({ service: "backend", endpoints: ownRpc });

    // Indexer.
    let indexer: SystemReport["indexer"] = { configured: d.indexer !== null, ok: false, progressBlock: null, sourceBlock: null, lagBlocks: null, lagSec: null, eventsProcessed: null, eventsPerMin: null, readyAt: null, error: d.indexer ? null : "not configured" };
    if (progress && !progress.ok) indexer = { ...indexer, error: progress.error };
    else if (progress?.ok && progress.value === null) indexer = { ...indexer, error: "the indexer has not started on this chain" };
    else if (progress?.ok && progress.value) {
      const v = progress.value;
      const ref = chain.head ?? v.progressBlock;
      const lagBlocks = Math.max(0, ref - v.progressBlock);
      const lagSec = v.progressBlockAt !== null ? Math.max(0, Math.round(((headBlock?.at ?? nowMs) - v.progressBlockAt) / 1000)) : null;
      let eventsPerMin: number | null = null;
      if (this.events && nowMs - this.events.at >= 10_000 && nowMs - this.events.at < 15 * 60_000) eventsPerMin = Math.round(((v.eventsProcessed - this.events.processed) / (nowMs - this.events.at)) * 60_000 * 10) / 10;
      if (!this.events || nowMs - this.events.at >= 10_000) this.events = { at: nowMs, processed: v.eventsProcessed };
      indexer = { configured: true, ok: lagSec === null || lagSec <= INDEXER_LAG_BAD_SEC, progressBlock: v.progressBlock, sourceBlock: chain.head, lagBlocks, lagSec, eventsProcessed: v.eventsProcessed, eventsPerMin, readyAt: null, error: null };
    }

    const lastRunAgeSec = lastRunAt !== null ? Math.max(0, Math.round((nowMs - lastRunAt) / 1000)) : null;
    const staleTrends = measured ? measured.filter((t) => nowSec - t.updatedAt > d.oracleStaleSec).length : null;
    const oracle: SystemReport["oracle"] = {
      ok: lastRunAgeSec !== null && lastRunAgeSec <= d.oracleStaleSec && (staleTrends ?? 0) === 0,
      lastRunAt,
      lastRunAgeSec,
      staleAfterSec: d.oracleStaleSec,
      liveTrends: live?.length ?? null,
      totalTrends: trends.ok ? trends.value.length : null,
      staleTrends,
      oldestUpdateAgeSec: oldest !== null ? Math.max(0, nowSec - oldest) : null,
      retireWindowSec: retire.ok ? retire.value : null,
      lastIndexedRun: indexed?.ok ? indexed.value.lastRun : null,
      lastSettlementAt: indexed?.ok && indexed.value.lastSettlementAt !== null ? indexed.value.lastSettlementAt * 1000 : null,
      settlements24h: indexed?.ok ? indexed.value.settlements24h : null,
      error: !lastRun.ok ? lastRun.error : !trends.ok ? trends.error : null,
    };
    const oracleFacts: Fact[] = [
      ...(lastRunAt !== null ? [{ label: "Last report", at: lastRunAt, tone: (lastRunAgeSec ?? 0) > d.oracleStaleSec ? ("bad" as const) : undefined }] : []),
      { label: "Live trends", value: live ? `${live.length} of ${trends.ok ? trends.value.length : "?"}` : "?" },
      { label: "Stale indexes", value: staleTrends === null ? "?" : String(staleTrends), tone: (staleTrends ?? 0) > 0 ? "bad" : "ok" },
      ...(keeperOracle ? [{ label: "Keeper sees", value: `${num(keeperOracle.live) ?? 0} live, ${num(keeperOracle.stale) ?? 0} stale` }] : []),
    ];
    services.push({
      name: "oracle",
      state: oracle.ok ? "up" : lastRunAgeSec === null || lastRunAgeSec > d.oracleStaleSec ? "down" : "degraded",
      core: true,
      httpStatus: null,
      latencyMs: null,
      lastSuccessAt: lastRunAt,
      lastError: oracle.error,
      alerts: [],
      facts: oracleFacts,
      wallets: [],
      rpc: [],
      reason: oracle.ok ? null : lastRunAgeSec === null ? "no report on chain" : lastRunAgeSec > d.oracleStaleSec ? `no report for ${ageText(lastRunAgeSec)}` : `${staleTrends} stale ${staleTrends === 1 ? "index" : "indexes"}`,
      derived: true,
    });
    if (d.indexer) {
      services.push({
        name: "indexer",
        state: indexer.error ? "down" : (indexer.lagSec ?? 0) > INDEXER_LAG_BAD_SEC ? "down" : (indexer.lagSec ?? 0) > INDEXER_LAG_WARN_SEC ? "degraded" : "up",
        core: true,
        httpStatus: null,
        latencyMs: null,
        lastSuccessAt: progress?.ok && progress.value?.progressBlockAt ? progress.value.progressBlockAt : null,
        lastError: indexer.error,
        alerts: [],
        facts: indexer.progressBlock !== null ? [{ label: "Block", value: `#${count(indexer.progressBlock)}` }, { label: "Behind", value: `${count(indexer.lagBlocks ?? 0)} blocks, ${ageText(indexer.lagSec ?? 0)}`, tone: (indexer.lagSec ?? 0) > INDEXER_LAG_WARN_SEC ? "warn" : "ok" }] : [],
        wallets: [],
        rpc: [],
        reason: indexer.error ?? ((indexer.lagSec ?? 0) > INDEXER_LAG_WARN_SEC ? `${ageText(indexer.lagSec ?? 0)} behind` : null),
        derived: true,
      });
    }

    // Jobs.
    const jobRows: JobReport[] = jobs.ok
      ? jobs.value.map((j) => {
          const ok = j.lastOkAt?.getTime() ?? null;
          const err = j.lastErrorAt?.getTime() ?? null;
          const interval = d.jobIntervals[j.job] ?? null;
          const staleAfter = interval !== null ? Math.max(3 * interval, interval + 600) * 1000 : null;
          const state: JobReport["state"] = err !== null && (ok === null || err > ok) ? "failing" : ok === null ? "never" : staleAfter !== null && nowMs - ok > staleAfter ? "stale" : "ok";
          return { job: j.job, lastOkAt: ok, lastErrorAt: err, lastError: j.lastError ? scrub(j.lastError, 200) : null, intervalSec: interval, state };
        })
      : [];
    const backendFacts: Fact[] = [
      { label: "Database", value: db.ok ? `ok, ${db.latencyMs} ms` : "down", tone: db.ok ? "ok" : "bad" },
      ...(d.startedAt ? [{ label: "Running since", at: d.startedAt }] : []),
      ...jobRows.filter((j) => j.job === "collector" || j.job === "radar").map((j): Fact => (j.lastOkAt !== null ? { label: `Last ${j.job}`, at: j.lastOkAt, tone: j.state === "ok" ? undefined : "warn" } : { label: `Last ${j.job}`, value: "never", tone: "warn" })),
    ];
    const collector = jobRows.find((j) => j.job === "collector");
    services.unshift({
      name: "backend",
      state: db.ok ? (jobRows.some((j) => j.state === "failing") ? "degraded" : "up") : "down",
      core: true,
      httpStatus: db.ok ? 200 : 503,
      latencyMs: 0,
      lastSuccessAt: collector?.lastOkAt ?? nowMs,
      lastError: db.ok ? null : db.error,
      alerts: [],
      facts: backendFacts,
      wallets: [],
      rpc: ownRpc,
      reason: !db.ok ? "the database is not answering" : jobRows.some((j) => j.state === "failing") ? `${jobRows.filter((j) => j.state === "failing").map((j) => j.job).join(", ")} failing` : null,
      derived: true,
    });

    // Sources.
    const stats = new Map(d.sources.stats().map((s) => [s.name, s]));
    const fresh = new Map((freshness.ok ? freshness.value : []).map((f) => [f.source as string, f]));
    const names = [...new Set([...SOURCE_ORDER, ...stats.keys()])].filter((n) => stats.has(n) || n in d.sources.configured);
    const sources: SourceReport[] = names.map((name) => {
      const s = stats.get(name) ?? { name, requests: 0, ok: 0, errors: 0, rateLimited: 0, lastOkAt: null, lastErrorAt: null, lastError: null, lastStatus: null };
      const configured = d.sources.configured[name] ?? true;
      const resting = d.sources.resting[name]?.() ?? false;
      const f = fresh.get(name);
      const state: SourceState = !configured ? "off" : resting ? "resting" : failing(s.lastOkAt, s.lastErrorAt, nowMs) ? "failing" : s.requests === 0 ? "idle" : "ok";
      const refresh = d.refreshSec[name as SourceName];
      const staleReading = f !== undefined && f.newestAt !== null && refresh !== undefined && nowMs - f.newestAt > 3 * refresh * 1000;
      return {
        name,
        label: SOURCE_LABELS[name] ?? name,
        state,
        requests: s.requests,
        ok: s.ok,
        errors: s.errors,
        rateLimited: s.rateLimited,
        lastOkAt: s.lastOkAt,
        lastErrorAt: s.lastErrorAt,
        lastError: s.lastError,
        newestReadingAt: f?.newestAt ?? null,
        readingsLastHour: f ? f.lastHour : null,
        staleReadings: staleReading,
        note: !configured ? "not configured" : staleReading ? `newest reading is older than ${ageText(3 * refresh!)}` : null,
      };
    });

    // AI.
    const ai: AiReport = {
      providers: d.ai.report().map((p) => ({ ...p, state: p.benchedUntil !== null && p.benchedUntil > nowMs ? "resting" : failing(p.lastOkAt, p.lastErrorAt, nowMs) ? "failing" : p.requests === 0 ? "idle" : "ok" })),
      leftToday: aiLeft?.ok ? aiLeft.value : null,
      dailyCalls: d.ai.dailyCalls,
    };

    // Wallets: the top-up service's targets and treasury, then any service wallet it does not fund.
    const treasury = topupBody ? describeHealth(topupBody).treasury : null;
    const rows: WalletRow[] = (Array.isArray(obj(topupBody)?.targets) ? (obj(topupBody)!.targets as unknown[]) : []).flatMap((x) => {
      const g = obj(x);
      if (!g || typeof g.account !== "string" || typeof g.name !== "string") return [];
      return [{ name: g.name, account: g.account, balance: str(g.balance), min: str(g.min), target: str(g.target), burnPerDay: str(g.burnPerDay), gasKeys: 0, gasKeyBalance: null, state: str(g.state), lastError: str(g.lastError) ? scrub(String(g.lastError), 200) : null, from: "topup" as const }];
    });
    // Each service's own view of its accounts adds their gas keys (and any account top-up does not fund).
    for (const s of services)
      for (const w of s.wallets) {
        const gasKeyBalance = w.gasKeys.length > 0 ? w.gasKeys.reduce((a, k) => a + Number(k.balance), 0).toFixed(4) : null;
        const row = rows.find((r) => r.account === w.account);
        if (row) {
          row.gasKeys = w.gasKeys.length;
          row.gasKeyBalance = gasKeyBalance;
          row.min ??= w.min;
        } else rows.push({ name: `${s.name} (${w.label.toLowerCase()})`, account: w.account, balance: w.balance, min: w.min, target: null, burnPerDay: null, gasKeys: w.gasKeys.length, gasKeyBalance, state: null, lastError: null, from: "service" });
      }

    // Elfa.
    const elfa = elfaReport(elfaIn?.ok ? elfaIn.value : null, nowMs, d.elfaLimits, d.fallback?.() ?? null, this.keyCheck);
    if (elfaIn && !elfaIn.ok) d.errors.seen("elfa", `usage could not be read: ${elfaIn.error}`);

    // The RPC gateway's providers' own errors, with their times.
    const gateway = gatewayBody ? gatewayReport(gatewayBody.body, nowMs) : null;
    for (const p of gateway?.providers ?? []) if (p.lastError && p.lastErrorAt) d.errors.note(gatewayBody!.name, `${p.provider}: ${p.lastError}`, Math.round(p.lastErrorAt / 10_000) * 10_000);

    const partial: Omit<SystemReport, "problems" | "status"> = {
      at: nowMs,
      database: { ok: db.ok, latencyMs: db.latencyMs, error: db.ok ? null : db.error },
      chain,
      indexer,
      oracle,
      services,
      rpc: { gateway, services: serviceRpc },
      elfa,
      sources,
      ai,
      jobs: jobRows,
      wallets: { treasury, rows },
      errors: [],
    };
    const problems = findProblems(partial);
    const report: SystemReport = { ...partial, status: overallStatus(problems), problems, errors: d.errors.recent(30) };
    return redactSecrets(report, d.secrets);
  }
}
