/** Shapes of the backend API (backend/src/api/app.ts). */

/** `retired`: the trend faded (retired after cooling) and left the queue. */
export const CANDIDATE_STATUSES = ["pending", "approved", "rejected", "live", "retired"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const ASSET_CLASSES = ["crypto", "equity", "commodity", "fx", "person", "politics", "topic"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export type CandidateSource =
  | "elfa_trending"
  | "elfa_narrative"
  | "wikipedia_top"
  | "bluesky_trend"
  | "coingecko_trending"
  | "geckoterminal_trending"
  | "link"
  | "seed"
  | "manual";

export interface CandidateAi {
  reason?: string;
  policyFlags?: string[];
  trendWorthy?: boolean;
  duplicateOf?: string | null;
}

/** An admin candidate, in the full form the admin endpoints return. */
export interface Candidate {
  id: number;
  identifier: string;
  displayName: string;
  summary: string | null;
  assetClass: AssetClass;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  source: CandidateSource;
  /** Credit the source's terms require next to its data (CoinGecko, GeckoTerminal), else null. */
  attribution?: { text: string; url: string } | null;
  surfacer: string;
  status: CandidateStatus;
  createdAt: string;
  confidence: number;
  ai: CandidateAi;
  /** Links: { url, platform, title }. Radar: { signal: { kind, ... } }. */
  sourceRef: Record<string, unknown>;
  decidedBy: string | null;
  updatedAt: string;
}

export interface DecisionRequest {
  decision: "approve" | "reject";
  identifier?: string;
  displayName?: string;
  keywords?: string[];
  article?: string | null;
  summary?: string;
}

export interface OracleHealth {
  trends: number;
  live: number;
  /** The oracle's last run id, which is the run's unix time in seconds. */
  lastRunId: number;
}

export interface KeyBudget {
  keys: number;
  leftToday: number;
}

export interface JobHealth {
  job: string;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastReport: Record<string, unknown> | null;
}

export interface Health {
  ok: boolean;
  /** "ok", or the database error. */
  db: string;
  /** The oracle summary, or the error that stopped it. */
  oracle: OracleHealth | string;
  /** `ai`: the day's AI provider calls the radar and pasted links share (older backends omit it). */
  budgets: { elfa: KeyBudget | null; nansen: KeyBudget | null; ai?: KeyBudget | null };
  /** Provider names in fallback order. */
  ai: string[];
  gdelt: "ok" | "resting";
  jobs: JobHealth[];
}

/** Jobs the admin API can start by hand. */
export const JOB_NAMES = ["radar", "collector", "history"] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface Trend {
  id: string;
  identifier: string;
  displayName: string | null;
  assetClass: AssetClass;
  status: string;
  index: number;
  peakIndex: number;
  updatedAt: number;
}

export interface TrendsResponse {
  lastRunId: number;
  trends: Trend[];
}

/** One Mainnet waitlist signup (backend/src/waitlist/routes.ts). */
export interface WaitlistRow {
  id: number;
  email: string;
  source: "app" | "landing";
  /** The Tredio account linked in the app, lowercase. */
  account: string | null;
  createdAt: string;
  updatedAt: string;
  invitedAt: string | null;
  unsubscribedAt: string | null;
}

/** A page of the waitlist, newest first, with counts over the whole list (`matching`: the search). */
export interface WaitlistPage {
  total: number;
  invited: number;
  linked: number;
  matching: number;
  limit: number;
  offset: number;
  rows: WaitlistRow[];
}

/** The admin system view (GET /v1/admin/system, backend/src/system.ts). Times are unix milliseconds. */
export type Severity = "critical" | "warning" | "info";
export type SystemArea = "database" | "services" | "oracle" | "elfa" | "ai" | "jobs" | "sources" | "freshness";

export interface Problem {
  severity: Severity;
  area: SystemArea;
  title: string;
  detail?: string;
}

/** One line of a service's health: a value, or a time shown as an age. */
export interface Fact {
  label: string;
  value?: string;
  at?: number;
  tone?: "ok" | "warn" | "bad" | "neutral";
}

export type ServiceState = "up" | "degraded" | "down";

export interface ServiceReport {
  name: string;
  state: ServiceState;
  core: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  alerts: string[];
  facts: Fact[];
  reason: string | null;
  /** Read by the backend itself (backend, oracle), not from a health endpoint. */
  derived: boolean;
}

export type ElfaKeyState = "ok" | "idle" | "rejected" | "rate-limited" | "quota" | "route-down" | "route-auth" | "error";

export interface ElfaKeyReport {
  index: number;
  /** The key's last four characters. */
  key: string;
  /** The key's route, host and port. */
  route: string;
  state: ElfaKeyState;
  benchedUntil: number | null;
  usedToday: number;
  usedMonth: number;
  allowanceToday: number;
  leftToday: number;
  projectedMonth: number;
  requests: number;
  failures: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastStatus: number | null;
  plan: string | null;
  narratives: boolean;
  busy: boolean;
}

export interface ElfaKeyCheck {
  index: number;
  key: string;
  route: string;
  outcome: "ok" | "rejected" | "quota" | "throttled" | "route-down" | "route-auth" | "plan" | "error";
  status: number | null;
  plan: string | null;
  free: boolean | null;
  usedThisMonth: number | null;
  monthlyLimit: number | null;
  remaining: number | null;
  error: string | null;
}

export interface ElfaReport {
  configured: boolean;
  keys: ElfaKeyReport[];
  skipped: string[];
  unusedRoutes: string[];
  limits: { dailyPerKey: number; monthlyPerKey: number };
  totals: { usedToday: number; usedMonth: number; allowanceToday: number; leftToday: number; monthly: number };
  narrativesAvailable: boolean;
  fallback: { capBytes: number; bytes: number; requests: number; month: string; pct: number } | null;
  lastCheck: { at: number; running: boolean; total: number; results: ElfaKeyCheck[] } | null;
}

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
  newestReadingAt: number | null;
  readingsLastHour: number | null;
  staleReadings: boolean;
  note: string | null;
}

export interface AiProviderReport {
  name: string;
  requests: number;
  ok: number;
  failures: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  benchedUntil: number | null;
  state: SourceState;
}

export interface JobReport {
  job: string;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  intervalSec: number | null;
  state: "ok" | "failing" | "stale" | "never";
}

export interface RecentError {
  source: string;
  message: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
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
  from: "topup" | "service";
}

export interface TreasuryReport {
  account: string;
  balance: string;
  floor: string;
  spendable: string;
  burnPerDay: string | null;
  runwayDays: number | null;
  low: boolean;
}

export interface SystemReport {
  at: number;
  status: "ok" | "degraded" | "critical";
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
    error: string | null;
  };
  wallets: { treasury: TreasuryReport | null; rows: WalletRow[] };
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
    lastIndexedRun: { runId: number; created: number; updated: number; marks: number; rejected: number; at: number } | null;
    lastSettlementAt: number | null;
    settlements24h: number | null;
    error: string | null;
  };
  services: ServiceReport[];
  elfa: ElfaReport;
  sources: SourceReport[];
  ai: { providers: AiProviderReport[]; leftToday: number | null; dailyCalls: number };
  jobs: JobReport[];
  errors: RecentError[];
}

/** One rotation: a faded live trend making room for a stronger approved candidate. */
export interface RotationRow {
  id: number;
  identifier: string;
  base: string;
  trendId: string;
  replacement: string | null;
  reason: string;
  status: "rotating" | "done" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
}

export interface BoardTrend {
  identifier: string;
  base: string;
  displayName: string | null;
  status: string;
  index: number;
  peakIndex: number;
  ageSec: number;
  pinned: boolean;
  rotatingOut: boolean;
  /** Its mentions over the last day, as the queue counts them. */
  mentions: number;
  /** Which rotation rules it meets now; `weaker` is fewer mentions than the strongest candidate waiting. */
  meets: { age: boolean; faded: boolean; belowMedian: boolean; weaker: boolean };
}

export interface RotationBoard {
  rules: { enabled: boolean; maxLive: number; minAgeSec: number; fadeRatio: number; timeoutSec: number; listGraceSec: number; cooldownSec: number };
  median: number | null;
  /** The approved candidate with the most mentions, the bar a live trend must fall under. */
  strongest: { identifier: string; mentions: number } | null;
  /** Kept topics not live now: they list again first, crypto without smart-money inflow. */
  keptWaiting: string[];
  /** Community picks: candidates enough accounts wait on, tried right after kept topics (most awaited first). */
  picks?: Array<{ identifier: string; watchers: number }>;
  pickRules?: { minWatchers: number; max: number };
  active: RotationRow | null;
  recent: RotationRow[];
  live: BoardTrend[];
}

