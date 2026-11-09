import { type ActivationTicket, type OwnerApproval, type OwnerApprovalAction, type OwnerApprovalRequest, type OwnerChallenge, ownerRequests } from "@tredio/contracts";
import type { AccountState as HlAccountState, Fill as HlFill, Leader as HlLeader, PerpMarket as HlMarket } from "@tredio/hyperliquid";
import { api, ApiError } from "./client";
import type { BacktestResult, FollowSettings, RuleInput, Stats } from "./types";

export { ApiError, hasUserToken, setReauth, setUserToken } from "./client";
export type * from "./types";
export type { HlAccountState, HlFill, HlLeader, HlMarket };

/** Typed calls to Tredio's API (backend/src/api/app.ts and the route modules), one per endpoint the app uses. */

/**
 * The account passkey's approval of one backend request (one prompt), which the account layer
 * provides. Following, resuming a follow, enabling a rule and linking a caller identity need it;
 * pausing, stopping and unfollowing do not.
 */
export type Approve = (request: OwnerApprovalRequest) => Promise<OwnerApproval>;

export const ownerApprovals = {
  /** A single-use nonce for the signed-in account to approve one action with. */
  challenge: (action: OwnerApprovalAction) => api<OwnerChallenge>("/v1/owner-approvals", { body: { action }, auth: true }),
};

export type SourceName = "elfa" | "bluesky" | "gdelt" | "hn" | "nansen" | "wikipedia";
export interface Reading {
  value: number;
  windowSec: number;
  observedAt: number;
}

export interface Trend {
  /** A trend's id is its identifier (`topic:openai`). */
  id: string;
  identifier: string;
  displayName: string | null;
  summary: string | null;
  assetClass: string;
  status: "active" | "cooling" | "retired" | "none";
  /** Index points, 0 to 100. */
  index: number;
  peakIndex: number;
  createdAt: number;
  updatedAt: number;
  /** The account that surfaced it, or "radar"/"" for the radar's own finds. */
  surfacer: string;
  /** SHA-256 of the NEAR AI Cloud review that approved it (GET /v1/reviews/:hash), or null. */
  reviewHash: string | null;
  /** The Hyperliquid perp of the underlying asset, if any. */
  asset: string | null;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  readings: Record<SourceName, Reading | null>;
  /** Index change over the last 24 hours, percent (list only). */
  change24h?: number | null;
  /** Hourly index values over the last 24 hours (list only). */
  spark?: number[];
  /** Being rotated out to make room: its rounds settle at its last index. */
  rotatingOut?: boolean;
}

export interface TrendDetail {
  trend: Trend;
  index: Array<{ t: number; v: number }>;
  history: Array<{ source: SourceName; value: number; observedAt: number }>;
  /** A retired listing whose topic listed again: the live listing's identifier. */
  relistedAs?: string | null;
}

export interface Candidate {
  id: number;
  identifier: string;
  displayName: string;
  summary: string | null;
  assetClass: string;
  keywords: string[];
  source: string;
  /** The credit the source's terms require next to its data (CoinGecko, GeckoTerminal), else null. */
  attribution?: { text: string; url: string } | null;
  surfacer: string;
  status: string;
  createdAt: string;
  /** Place in the oracle's queue (1 lists first), or null while it has no usable reading. */
  queue?: number | null;
  signal?: { label: string; count: number | null; unit: string | null } | null;
  readings?: { mentions: number | null; bluesky: number | null; wikipedia: number | null; news: number | null; hn: number | null };
  spark?: number[];
  heating?: number | null;
  watchers?: number;
  pick?: boolean;
}

export interface Radar {
  slots?: { live: number; max: number };
  candidates: Candidate[];
}

export type AlertKind = "rise" | "drop" | "above" | "below";

export interface AttentionAlert {
  id: number;
  /** The topic's base identifier: an alert follows the topic across listings. */
  trend: string;
  identifier: string | null;
  name: string;
  kind: AlertKind;
  changePct: number | null;
  windowMin: number | null;
  level: number | null;
  createdAt: string;
  lastFiredAt: string | null;
  firedCount: number;
}

export type NewAlert = { trend: string; kind: "rise" | "drop"; changePct: number; windowMin: number } | { trend: string; kind: "above" | "below"; level: number };

export const alerts = {
  list: () => api<{ alerts: AttentionAlert[]; max: number }>("/v1/alerts", { auth: true }),
  create: (a: NewAlert) => api<{ alert: AttentionAlert; alreadyPast: boolean }>("/v1/alerts", { body: a, auth: true }),
  remove: (id: number) => api<{ removed: number }>(`/v1/alerts/${id}`, { method: "DELETE", auth: true }),
};

export const trends = {
  list: (all = false) => api<{ lastRunId: number; trends: Trend[] }>(`/v1/trends${all ? "?all=1" : ""}`),
  get: (identifier: string) => api<TrendDetail>(`/v1/trends/${encodeURIComponent(identifier)}`),
  upcoming: () => api<Radar>("/v1/candidates"),
  watching: () => api<{ ids: number[] }>("/v1/candidates/watching", { auth: true }),
  watch: (id: number, on: boolean) => api<{ watching: boolean }>(`/v1/candidates/${id}/watch`, { method: on ? "POST" : "DELETE", auth: true }),
  thread: (identifier: string) => api<{ posts: Post[]; calls: Call[] }>(`/v1/trends/${encodeURIComponent(identifier)}/thread`),
};

/** The signed evidence of a listing's NEAR AI Cloud review. */
export interface Review {
  hash: string;
  evidence: unknown;
  createdAt: string;
}
export const reviews = {
  get: (hash: string) => api<Review>(`/v1/reviews/${hash.toLowerCase()}`),
};

export interface LinkResult {
  requestId: number;
  status: "approved" | "pending" | "rejected" | "live" | "failed";
  identifier?: string;
  displayName?: string;
  summary?: string;
  reason: string;
  firstSurfacer?: boolean;
}
export const links = {
  /** Signed in only: the proposer (and first curator, if it lists) is the signed-in account. */
  propose: (url: string) => api<LinkResult>("/v1/links", { body: { url }, auth: true }),
};

export interface StoredRule {
  id: number;
  owner: string;
  rule: RuleInput;
  /** Which rule exactly: backtests and approvals to enable name it. */
  ruleHash: string;
  status: "draft" | "enabled" | "paused" | "stopped";
  statusReason: string | null;
  route: "api" | "session";
  backtestId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RulePosition {
  id: string;
  market: string;
  side: "long" | "short";
  status: string;
  size: number;
  entry_price: number | null;
  margin_usdc: number;
  leverage: number;
  opened_at: string | null;
  closed_at: string | null;
  exit_price: number | null;
  pnl_usdc: number | null;
  fees_usdc: number;
  close_reason: string | null;
}

export interface RuleDetail {
  rule: StoredRule;
  stats: Stats;
  equity: Array<{ t: number; v: number }>;
  positions: RulePosition[];
  audit: Array<{ id: string; at: string; event: string; detail: Record<string, unknown> }>;
  backtest: { id: number; createdAt: string; stats: Stats; warnings: string[] } | null;
}

export interface Grant {
  sessionKey: string;
  status: "pending" | "active" | "revoked" | "expired";
  validUntil: number;
  dailyLimit: string;
  /** A replacement key requested while this grant is active; the grant switches to it once it is on chain. */
  nextSessionKey?: string | null;
  /** The policy wallet whose key the session is for, with its state; null for a sealed session key. */
  wallet?: GrantWallet | null;
}

/**
 * A policy wallet behind a grant: an OutLayer custody wallet (testnet) or an Agent API agent
 * (mainnet), whose enclave signs Autopilot's session calls within a policy the account controls.
 */
export interface GrantWallet {
  kind: "outlayer" | "agent-api";
  /** The wallet's NEAR account (implicit), which sends the calls and pays their gas. */
  account: string;
  agentId: string | null;
  /** Null when it could not be read just now. */
  frozen: boolean | null;
  controller: string | null;
  /** yoctoNEAR the wallet holds for gas. */
  balance: string | null;
}

/** What the passkey signs for an Agent API owner action: WebAuthn request options (challenge base64url). */
export interface AgentWebAuthn {
  challenge: string;
  rpId: string;
  allowCredentials: Array<{ id: string; type: "public-key" }>;
  userVerification: "required";
  timeout: number;
}

/** The session the API asks the account to add for Autopilot (its passkey adds it). */
export interface GrantSession {
  public_key: string;
  label: string;
  scope: { outcomes: boolean; perps: boolean; hyperliquid: boolean };
  expires_at: number;
  daily_limit: string;
  gas_key: boolean;
}

export interface Follow {
  id: number;
  follower: string;
  /** A Hyperliquid address (0x...). */
  leader: string;
  settings: FollowSettings;
  status: "active" | "paused" | "stopped";
  statusReason: string | null;
  createdAt: string;
}

/** Autopilot's markets (AUTOPILOT_MARKETS) that Hyperliquid lists on this network. */
export interface AutopilotMarket {
  index: number;
  symbol: string;
  maxLeverage: number;
  szDecimals: number;
  markPx: number;
}

export const autopilot = {
  markets: () => api<{ markets: AutopilotMarket[] }>("/v1/autopilot/markets"),
  performance: (owner: string) => api<{ owner: string; stats: Stats; equity: Array<{ t: number; v: number }>; followers: number }>(`/v1/autopilot/performance/${encodeURIComponent(owner.toLowerCase())}`),
  backtest: (rule: RuleInput, days: number) => api<{ id: number; ruleHash: string; result: BacktestResult & { resolutionSec: number; trendId: string | null } }>("/v1/autopilot/backtests", { body: { rule, days }, auth: true }),
  rules: () => api<{ rules: StoredRule[] }>("/v1/autopilot/rules", { auth: true }),
  rule: (id: number) => api<RuleDetail>(`/v1/autopilot/rules/${id}`, { auth: true }),
  create: (rule: RuleInput) => api<{ rule: StoredRule }>("/v1/autopilot/rules", { body: { rule }, auth: true }),
  update: (id: number, rule: RuleInput) => api<{ rule: StoredRule }>(`/v1/autopilot/rules/${id}`, { method: "PUT", body: { rule }, auth: true }),
  /** Pausing or stopping: no prompt. */
  setStatus: (id: number, status: "paused" | "stopped") => api<{ rule: StoredRule }>(`/v1/autopilot/rules/${id}/status`, { body: { status }, auth: true }),
  /** Enabling or resuming: the passkey approves exactly this rule first. */
  enable: async (rule: Pick<StoredRule, "id" | "ruleHash">, approve: Approve) => {
    const approval = await approve(ownerRequests.enableRule(rule.id, rule.ruleHash));
    return api<{ rule: StoredRule }>(`/v1/autopilot/rules/${rule.id}/status`, { body: { status: "enabled", ruleHash: rule.ruleHash, approval }, auth: true });
  },
  grant: () => api<{ grant: Grant | null }>("/v1/autopilot/grant", { auth: true }),
  /** The executor's public key, which the app seals grant keys to. */
  sealKey: () => api<{ publicKey: string }>("/v1/autopilot/grant/seal-key"),
  /** A key made on this device: the API gets its public key and a box only the executor opens. */
  requestGrant: (dailyLimit: bigint, validDays: number, key: { sessionKey: string; sealedKey: string }, wallet?: { kind: "outlayer"; account: string } | { kind: "agent-api"; account: string; agentId: string }) =>
    api<{ session: GrantSession }>("/v1/autopilot/grant", { body: { dailyLimit: dailyLimit.toString(), validDays, sessionKey: key.sessionKey, sealedKey: key.sealedKey, ...(wallet ? { wallet } : {}) }, auth: true }),
  confirmGrant: () => api<{ grant: Grant }>("/v1/autopilot/grant/confirm", { body: {}, auth: true }),
  /** #mainnet: an owner action of the account's Agent API agent, prepared by the API for the passkey to sign. */
  agentIntent: (
    body:
      | { type: "agent_create"; credentialId: string; rpId: string; origin: string }
      | { type: "grant_issue"; agentId: string; commitment: string; validDays: number }
      | { type: "agent_freeze" | "agent_unfreeze"; agentId: string },
  ) => api<{ correlationId: string; type: string; agentId: string; summary: string; webauthn: AgentWebAuthn }>("/v1/autopilot/agent/intent", { body, auth: true }),
  /** #mainnet: the passkey's assertion for a prepared agent intent; the API submits it and waits for the outcome. */
  agentSubmit: (correlationId: string, credential: unknown) => api<{ status: string; agentId: string; account: string | null }>("/v1/autopilot/agent/submit", { body: { correlationId, credential }, auth: true }),
  follows: () => api<{ follows: Follow[] }>("/v1/follows", { auth: true }),
  /** Following or changing caps: the passkey approves the leader and these settings first. */
  follow: async (leader: string, settings: FollowSettings, approve: Approve) => {
    const approval = await approve(ownerRequests.follow(leader, settings));
    return api<{ follow: Follow }>("/v1/follows", { body: { leader, settings, approval }, auth: true });
  },
  resumeFollow: async (id: number, approve: Approve) => {
    const approval = await approve(ownerRequests.resumeFollow(id));
    return api<{ ok: true }>(`/v1/follows/${id}/status`, { body: { status: "active", approval }, auth: true });
  },
  setFollowStatus: (id: number, status: "paused" | "stopped") => api<{ ok: true }>(`/v1/follows/${id}/status`, { body: { status }, auth: true }),
};

/** Hyperliquid through the API: markets with marks and funding, an account's address and positions, leaders. */
export interface HlOpenOrder {
  coin: string;
  oid: number;
  side: "B" | "A";
  limitPx: number;
  sz: number;
  timestamp: number;
}
export const hyperliquid = {
  markets: () => api<{ network: "testnet" | "mainnet"; markets: HlMarket[] }>("/v1/hyperliquid/markets"),
  /** The account's Hyperliquid address (its own Chain Signatures key) and what it holds there. */
  account: (account: string) => api<{ network: "testnet" | "mainnet"; address: string; state: HlAccountState | null; orders: HlOpenOrder[] }>(`/v1/hyperliquid/accounts/${encodeURIComponent(account)}`),
  fills: (account: string) => api<{ address: string; fills: HlFill[] }>(`/v1/hyperliquid/accounts/${encodeURIComponent(account)}/fills`),
  /** Mainnet's public leaderboard (Hyperliquid has none on testnet): a testnet follower copies their mainnet positions. */
  leaders: () => api<{ source: string; leaders: Array<HlLeader & { followers: number }> }>("/v1/hyperliquid/leaders"),
};

export interface Call {
  id: number;
  caller: string;
  handle?: string | null;
  identifier?: string;
  direction: "up" | "down";
  horizon_sec: number;
  note: string | null;
  called_at: number;
  opening_index: number;
  resolves_at: number;
  closing_index: number | null;
  outcome: "open" | "hit" | "miss" | "void";
}

export interface CallCreated {
  id: number;
  caller: string;
  identifier: string;
  direction: "up" | "down";
  horizonSec: number;
  openingIndex: number;
  calledAt: number;
  resolvesAt: number;
}

export interface Post {
  id: number;
  caller: string;
  handle: string | null;
  body: string;
  reply_to: number | null;
  call_id: number | null;
  created_at: string;
}

export interface CallerRow {
  /** The caller identity: an ed25519 public key as 64 hex characters. */
  address: string;
  handle: string | null;
  linked_account: string | null;
  hits: number;
  misses: number;
  open: number;
  resolved: number;
  hitRate: number;
  score: number;
}

export interface CallerProfileView {
  caller: { address: string; handle: string | null; bio: string | null; linked_account: string | null; created_at: string };
  /** Over every call the caller made (as the leaderboard counts them); `calls` is the newest 100. */
  stats: CallerRecord & { total: number };
  calls: Call[];
}

/** A caller's track record: resolved calls are hits and misses (voids do not count). */
export interface CallerRecord {
  hits: number;
  misses: number;
  open: number;
  resolved: number;
  hitRate: number;
  score: number;
}

export const social = {
  call: (body: { caller: string; identifier: string; direction: "up" | "down"; horizonSec: number; note: string; issuedAt: number; signature: string }) => api<{ call: CallCreated }>("/v1/calls", { body }),
  post: (body: { caller: string; identifier: string; body: string; replyTo: number | null; callId: number | null; issuedAt: number; signature: string }) => api<{ post: { id: number } }>("/v1/posts", { body }),
  leaderboard: () => api<{ callers: CallerRow[] }>("/v1/callers/leaderboard"),
  /** A caller's profile; no profile yet throws a 404 ApiError (asked as optional, so the browser logs no failed request). */
  caller: async (idOrHandle: string) => {
    const r = await api<CallerProfileView | { caller: null }>(`/v1/callers/${encodeURIComponent(idOrHandle)}?optional=1`);
    if (!r.caller) throw new ApiError(404, "no such caller");
    return r as CallerProfileView;
  },
  profile: (body: { caller: string; handle: string; bio: string; issuedAt: number; signature: string }) => api<{ caller: { address: string; handle: string; bio: string } }>("/v1/callers/me", { method: "PUT", body }),
  /** Linking: the caller identity signs, and the account's passkey approves (one prompt). */
  link: async (body: { identity: string; account: string; issuedAt: number; identitySignature: string }, approve: Approve) => {
    const approval = await approve(ownerRequests.linkIdentity(body.identity));
    return api<{ caller: string; linkedAccount: string }>("/v1/callers/link", { body: { ...body, approval } });
  },
  identitySession: (identity: string, issuedAt: number, signature: string) => api<{ token: string; identity: string; expiresAt: number }>("/v1/identity/session", { body: { identity, issuedAt, signature } }),
};

/** A paid signals channel: a caller identity linked to the account it is paid to and commits from. */
export interface SignalChannel {
  leader: string;
  /** The follow leader id for copying it: `signals:<identity>`. */
  leaderId?: string;
  handle: string | null;
  account: string | null;
  /** USDC, atomic (6 decimals), for one period of early access. */
  price_usdc: string;
  period_days: number;
  reveal_delay_sec: number;
  signals?: number;
  last?: number | null;
}

/** A signal as the feed lists it: sealed until `revealAt`, then also in the clear. */
export interface SignalItem {
  id: number;
  leader: string;
  handle: string | null;
  epoch: number;
  iv: string;
  ciphertext: string;
  /** SHA-256 of the signed message, committed on chain in `commitTx`'s USDC memo before anyone could read it. */
  commitment: string;
  signature: string;
  commitTx: string;
  issuedAt: number;
  committedAt: number;
  revealAt: number;
  signal: SignalBody | null;
}

export interface SignalBody {
  leader: string;
  kind: "open" | "close";
  market: string;
  side: "long" | "short";
  marginUsdc: number | null;
  leverage: number | null;
  note: string;
  issuedAt: number;
  price: number;
}

export const signals = {
  channels: () => api<{ channels: SignalChannel[] }>("/v1/signals/channels"),
  feed: (leader?: string, limit = 50) => api<{ now: number; signals: SignalItem[] }>(`/v1/signals?limit=${limit}${leader ? `&leader=${leader}` : ""}`),
  /** The viewing keys the signed-in account holds for a channel (402 without early access). */
  keys: (leader: string) => api<{ leader: string; expiresAt: number | null; keys: Array<{ epoch: number; key: string }> }>(`/v1/signals/${leader}/keys`, { auth: true }),
  access: (leader: string) => api<{ leader: string; expiresAt: number | null; active: boolean }>(`/v1/signals/${leader}/access`, { auth: true }),
  /** Claims early access with the USDC payment the account made to the leader's account. */
  claim: (leader: string, tx: string, sender: string) => api<{ leader: string; startsAt: number; expiresAt: number }>(`/v1/signals/${leader}/access`, { body: { tx, sender }, auth: true }),
  setChannel: (body: { caller: string; priceUsdc: string; periodDays: number; revealDelaySec: number; issuedAt: number; signature: string }) => api<{ channel: SignalChannel }>("/v1/signals/channel", { method: "PUT", body }),
  publish: (body: { caller: string; signal: { kind: "open" | "close"; market: string; side: "long" | "short"; marginUsdc?: number; leverage?: number; note: string }; issuedAt: number; signature: string; commitTx: string; commitSender: string }) =>
    api<{ signal: { id: number; commitment: string; commitTx: string; committedAt: number; revealAt: number; epoch: number } }>("/v1/signals", { body }),
};

export interface VaultItem {
  kind: "strategy" | "note";
  item_id: string;
  ciphertext: string;
  iv: string;
  version: number;
  updated_at: string;
}
export const vault = {
  list: (token: string, kind?: "strategy" | "note") => api<{ items: VaultItem[] }>(`/v1/vault${kind ? `?kind=${kind}` : ""}`, { token }),
  put: (token: string, kind: "strategy" | "note", id: string, item: { ciphertext: string; iv: string; version: number }) => api<{ ok: true; version: number }>(`/v1/vault/${kind}/${id}`, { method: "PUT", body: item, token }),
  remove: (token: string, kind: "strategy" | "note", id: string) => api<{ ok: true }>(`/v1/vault/${kind}/${id}`, { method: "DELETE", token }),
};

export const push = {
  vapid: () => api<{ publicKey: string }>("/v1/push/vapid"),
  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string }; topics?: string[] }) => api<{ ok: true }>("/v1/push/subscriptions", { body: sub, auth: true }),
  unsubscribe: (endpoint: string) => api<{ ok: true }>("/v1/push/subscriptions", { method: "DELETE", body: { endpoint }, auth: true }),
};

/** A service account and its gas keys, as the status page shows the fleet. */
export interface FleetWallet {
  service: string;
  label: string;
  account: string;
  /** NEAR, decimal. */
  balance: string | null;
  gasKeys: Array<{ publicKey: string; balance: string; nonces: number }>;
}

export interface SystemStatus {
  ok: boolean;
  network: "testnet" | "mainnet";
  /** `issue`: why a down service is down, in a few words ("not answering", "balance below 1 NEAR"); `startedAt`: when its process started (unix seconds). */
  services: Array<{ name: string; ok: boolean; latencyMs: number | null; issue?: string | null; startedAt?: number | null }>;
  oracle: { ok: boolean; lastRunAgeSec: number | null; staleTrends: number };
  chain: { ok: boolean; ageSec: number | null; height: number | null };
  /** Each Tredio contract's NEAR above its storage: a contract that cannot pay for new state refuses every write. */
  contracts?: Array<{ role: string; account: string; freeNear: string | null; ok: boolean; low: boolean }>;
  fleet: FleetWallet[];
  at: number;
}
export const system = {
  /** The system status; a 503 still carries the status body, which names what is down. */
  status: () =>
    api<SystemStatus>("/v1/status?soft=1").catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 503 && e.body && typeof e.body === "object" && "services" in e.body) return e.body as SystemStatus;
      throw e;
    }),
};

/** History from Tredio's indexer (backend/src/indexer.ts). */
export interface AccountHistory {
  account: string;
  isPasskey: boolean;
  createdAt: number | null;
  firstSeenAt: number;
  lastActiveAt: number | null;
  outcomeHoldingCount: number;
  coinHoldingCount: number;
  perpOpenPositionCount: number;
  openOrderCount: number;
  curationClaimableUsdc: number;
  stats: {
    volumeUsdc: number;
    realizedPnlUsdc: number;
    perProduct: { outcome: number; perp: number; coin: number };
    feesPaidUsdc: number;
    tradeCount: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    bestTradeUsdc: number | null;
    worstTradeUsdc: number | null;
    liquidations: number;
  };
}

export interface ActivityItem {
  /** "assetPerp" items come from Hyperliquid fills, merged in by the app. */
  kind: "perp" | "coin" | "outcome" | "assetPerp";
  identifier: string | null;
  label: string;
  side: string;
  status: string;
  amountUsdc: number | null;
  pnlUsdc: number | null;
  entry: number | null;
  exit: number | null;
  at: number;
  /** The receipt that recorded it (NearBlocks finds a transaction by any of its receipts). */
  receipt: string | null;
}

/** A series the indexer says the account holds or held, with its average-cost book (raw, 6 decimals). */
export interface IndexedOutcomeHolding {
  series: number;
  trend: string;
  window: number;
  openedAt: number;
  expiry: number;
  openingIndex: number;
  outcome: "open" | "up" | "down" | "void";
  settlementIndex: number | null;
  upBalance: string;
  downBalance: string;
  upPosition: string;
  downPosition: string;
  upCostBasis: string;
  downCostBasis: string;
  upRealizedPnl: string;
  downRealizedPnl: string;
  upUpdatedAt: number;
  downUpdatedAt: number;
}

export interface TraderRow {
  account: string;
  realizedPnlUsdc: number;
  volumeUsdc: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface TrendStats {
  volumeUsdc: number;
  volume24hUsdc: number;
  tradeCount: number;
  traderCount: number;
  holderCount: number;
  perpLongOpenInterestUsdc: number;
  perpShortOpenInterestUsdc: number;
  perpOpenPositionCount: number;
  curationEarnedUsdc: number;
  coin: { stage: string; spotUsdc: number; reserveUsdc: number; graduatedAt: number | null } | null;
}

export const history = {
  /** An account's record; no activity yet throws a 404 ApiError (asked as optional, so the browser logs no failed request). */
  account: async (account: string) => {
    const r = await api<{ account: AccountHistory | null }>(`/v1/accounts/${encodeURIComponent(account)}?optional=1`);
    if (!r.account) throw new ApiError(404, "no activity yet");
    return { account: r.account };
  },
  activity: (account: string, limit = 50) => api<{ items: ActivityItem[] }>(`/v1/accounts/${encodeURIComponent(account)}/activity?limit=${limit}`),
  outcomes: (account: string) => api<{ holdings: IndexedOutcomeHolding[] }>(`/v1/accounts/${encodeURIComponent(account)}/outcomes`),
  traders: () => api<{ traders: TraderRow[] }>("/v1/leaderboard/traders"),
  /** Null until the listing has traded. */
  trend: (identifier: string) => api<{ stats: TrendStats | null }>(`/v1/trends/${encodeURIComponent(identifier)}/stats`),
};

/** Any-chain deposits and withdrawals through NEAR Intents 1Click (dry quotes on testnet). */
export interface DepositAsset {
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  priceUsd: number;
}

export interface OneClickQuote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  /** Seconds. */
  timeEstimate: number;
}

export interface DepositRow {
  id: number;
  direction: "deposit" | "withdraw" | "hyperliquid" | "from-hyperliquid";
  depositAddress: string;
  depositMemo: string | null;
  amountIn: string;
  amountOut: string;
  amountInUsd: string;
  originAsset: string;
  destinationAsset: string;
  deadline: string | null;
  phase: string;
  explorer: string;
  createdAt: string;
  updatedAt: string;
}

export type QuoteRequest =
  | { direction: "deposit"; asset: string; amount: string; refundTo: string }
  | { direction: "withdraw"; asset: string; amount: string; recipient: string }
  | { direction: "hyperliquid"; amount: string; hyperliquidAddress: string }
  /** USDC back from the account's Hyperliquid balance to NEAR: `amount` micro-USDC; the account then sends the quote's `amountIn` (8 decimals) to its deposit address on Hyperliquid. */
  | { direction: "from-hyperliquid"; amount: string; hyperliquidAddress: string };

export interface QuoteAnswer {
  dry: boolean;
  direction: QuoteRequest["direction"];
  confidential: boolean;
  quote: OneClickQuote;
  signature: string;
  deposit?: DepositRow;
}

export const deposits = {
  assets: () => api<{ network: "testnet" | "mainnet"; live: boolean; confidential: boolean; assets: DepositAsset[] }>("/v1/deposits/assets"),
  quote: (body: QuoteRequest) => api<QuoteAnswer>("/v1/deposits/quote", { body, auth: true }),
  list: () => api<{ live: boolean; deposits: DepositRow[] }>("/v1/deposits", { auth: true }),
  submit: (id: number, txHash: string) => api<{ phase: string }>(`/v1/deposits/${id}/submit`, { body: { txHash }, auth: true }),
};

/** The Mainnet waitlist. The answer is the same for a new email and a listed one. */
export const waitlist = {
  join: (body: { email: string; account: string | null; consent: true; website: string }) => api<{ ok: true }>("/v1/waitlist", { body: { ...body, source: "app" } }),
};

/** Testnet USDC comes from the token's own faucet; this says what it pays and when the account may draw again. */
export interface FaucetInfo {
  available: boolean;
  contract?: string;
  /** Raw USDC per draw. */
  amount?: string;
  cooldownSec?: number;
  /** Unix seconds the account may draw again, or null when it never drew. */
  nextAt?: number | null;
}
export const faucet = {
  info: (account?: string) => api<FaucetInfo>(`/v1/faucet${account ? `?account=${encodeURIComponent(account)}` : ""}`),
};

/**
 * Sign-up: the relayer pays for an account only with the API's ticket for it. Null when the API has
 * no ticket key (a local setup), so the relayer decides; refusals (sign-up caps, an account that
 * exists) throw with the API's message.
 */
export const activation = {
  ticket: async (ownerKey: string): Promise<ActivationTicket | null> => {
    try {
      return await api<ActivationTicket>("/v1/activation-ticket", { body: { ownerKey } });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || (e.status === 503 && e.message === "activation tickets are not configured"))) return null;
      throw e;
    }
  },
};

export const auth = {
  /** NEP-413 sign-in by a session key or a wallet's full-access key. */
  session: (body: { account: string; signer: string; issuedAt: number; signature: string; nonce: string }) => api<{ token: string; account: string; expiresAt: number }>("/v1/auth/session", { body }),
  revoke: (token: string) => api<{ ok: true }>("/v1/auth/session/revoke", { body: {}, token }),
};
