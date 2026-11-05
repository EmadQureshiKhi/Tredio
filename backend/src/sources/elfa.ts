import type { KeyRing, KeyUsage } from "../budget";
import { scrub } from "../errors";
import { BudgetError, type Fetch, fetchJson, HttpError, isKeyRejected, isQuotaError, isThrottled, query } from "./http";
import { type CallPacer, PacedError } from "./pacer";

/**
 * Elfa API v2 (https://docs.elfa.ai): X and Telegram attention. Every call reserves its credits on
 * the key ring first (keyword mentions and trending tokens cost 1, narratives 5).
 *
 * A key may carry a route (`proxyFor`), attached per request and only to a request for the Elfa
 * API's own host (elfaProxy). A route that fails rests its key and the call moves to the next key.
 *
 * With a pacer, calls go out one at a time with a gap between them, each key rests between its own
 * uses, and the key is drawn at random, weighted by the credits it has left today.
 *
 * Trending narratives are paid-only: a key whose plan Elfa reports as free, or that Elfa refuses
 * with a 402 or 403 there, never asks for them again, and the radar takes narratives from Bluesky.
 */

export interface TrendingToken {
  token: string;
  currentCount: number;
  previousCount: number;
  changePercent: number;
}

export interface Narrative {
  narrative: string;
  links: string[];
}

/** What `/v2/key-status` says about a key, as far as its answer shows it. */
export interface KeyStatus {
  plan: string | null;
  /** True for a free plan, false for a paid one, null when the answer does not tell. */
  free: boolean | null;
  usedThisMonth: number | null;
  monthlyLimit: number | null;
  remaining: number | null;
}

/** Options for spacing calls out. */
export interface ElfaPacing {
  pacer?: CallPacer | null;
  /** Gap between keys during a key check, drawn between these bounds (ms). */
  checkGapMs?: readonly [number, number];
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Longest a caller that may wait waits for a key to come off its rest. */
export const MAX_KEY_WAIT_MS = 15 * 60_000;

/** Keyword-mentions windows must span one to thirty days. */
export const MIN_MENTIONS_WINDOW_SEC = 86_400;
/** How long a key rests after its route failed (unreachable, timed out, refused). */
export const PROXY_REST_MS = 5 * 60_000;
/** How long a key rests after its route refused its credentials (407): a config fix is needed. */
export const PROXY_AUTH_REST_MS = 60 * 60_000;

/** How a key's last call ended, for health. */
export type KeyOutcome = "ok" | "rejected" | "quota" | "throttled" | "route-down" | "route-auth" | "plan" | "error";

/** One key's calls since the process started, for the admin system view. Never the key itself. */
export interface KeyCalls {
  keyId: string;
  requests: number;
  ok: number;
  failures: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  /** Scrubbed: Elfa's own code and message, or the route's failure without its credentials. */
  lastError: string | null;
  lastStatus: number | null;
  lastOutcome: KeyOutcome | null;
  /** What the last key-status check said, and when. */
  check: (KeyStatus & { at: number }) | null;
}

/** The result of checking one key's status (the admin "check keys" action and the start-up sync). */
export interface KeyCheck {
  keyId: string;
  outcome: KeyOutcome;
  status: number | null;
  plan: string | null;
  free: boolean | null;
  usedThisMonth: number | null;
  monthlyLimit: number | null;
  remaining: number | null;
  error: string | null;
}

/** Elfa's own error code and message from a refusal, or what failed, never anything that could echo a key or a route's credentials. */
export function failureText(e: unknown): string {
  if (e instanceof HttpError) {
    let detail = "";
    try {
      const j = JSON.parse(e.body) as { code?: unknown; message?: unknown; error?: unknown };
      detail = [j.code, j.message ?? j.error].filter((x) => typeof x === "string").join(" ");
    } catch {
      detail = e.body.trim() === "" ? "empty body (refused before reaching Elfa)" : "";
    }
    return scrub(`HTTP ${e.status}${detail ? ` ${detail}` : ""}`, 160);
  }
  return scrub(e instanceof Error ? e.message : String(e), 160);
}

/** The endpoint needs a plan this key does not have. */
export class PlanError extends Error {
  constructor(what: string) {
    super(`elfa: ${what} needs a paid Elfa plan`);
  }
}

/** A failure of the route rather than of Elfa: no answer at all, or the route's own empty refusal. */
function proxyFailure(e: unknown): "auth" | "down" | null {
  // No HTTP answer at all: unreachable, refused or timed out. A body that is not JSON is Elfa's to explain.
  if (!(e instanceof HttpError)) return e instanceof Error && !/not JSON/.test(e.message) ? "down" : null;
  if (e.status === 407) return "auth";
  return e.body.trim() === "" && (e.status === 403 || e.status === 502 || e.status === 503 || e.status === 504) ? "down" : null;
}

/**
 * The fetch option that sends `url` through `proxy`, after checking that `url` is on the Elfa API's
 * host: a key's route never carries another source's request.
 */
export function elfaProxy(elfaHost: string, url: string, proxy: string | null): { proxy?: string } {
  if (proxy === null) return {};
  if (new URL(url).host !== elfaHost) throw new Error(`elfa: a key's proxy only ever carries requests to ${elfaHost}`);
  return { proxy };
}

/** A refusal of a paid-only endpoint: 402 or 403 with Elfa's own body, not a rejected key. */
export function isPlanGated(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 402 || e.status === 403) && e.body.trim() !== "" && !isKeyRejected(e);
}

export class Elfa {
  /** Keys that may not call paid-only endpoints. */
  private readonly gated = new Set<string>();
  /** Keys Elfa reported a paid plan for. */
  private readonly paid = new Set<string>();
  private readonly host: string;
  /** Requests in flight per route. */
  private readonly inFlight = new Map<string, number>();
  /** Each key's calls, for health. */
  private readonly calls = new Map<string, KeyCalls>();

  constructor(
    private readonly ring: KeyRing,
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly proxyFor: (keyId: string) => string | null = () => null,
    /** Never use a key without a route. */
    private readonly requireProxy = false,
    private readonly pacing: ElfaPacing = {},
  ) {
    this.host = new URL(baseUrl).host;
  }

  private get pacer(): CallPacer | null {
    return this.pacing.pacer ?? null;
  }

  private sleep(ms: number): Promise<void> {
    return (this.pacing.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  /** Milliseconds until the next Elfa call could start (0 without a pacer or when one may start now). */
  nextCallInMs(): number {
    return this.pacer?.waitMs() ?? 0;
  }

  /** A ready key drawn at random, weighted by the credits it has left today. */
  private readonly weighted = (ready: KeyUsage[]): KeyUsage => {
    const total = ready.reduce((a, u) => a + u.left, 0);
    let r = (this.pacing.random ?? Math.random)() * total;
    for (const u of ready) {
      r -= u.left;
      if (r < 0) return u;
    }
    return ready[ready.length - 1]!;
  };

  /** Routes with an Elfa request in flight. */
  busyProxies(): ReadonlySet<string> {
    return new Set([...this.inFlight].filter(([, n]) => n > 0).map(([p]) => p));
  }

  /** Each key's calls since the process started, in key order. */
  keyCalls(): KeyCalls[] {
    return this.ring.keyIds.map((id) => ({ ...this.callsOf(id) }));
  }

  /** Whether a key may ask for paid-only endpoints (false once Elfa said its plan cannot). */
  narrativesAllowed(keyId: string): boolean {
    return !this.gated.has(keyId);
  }

  private callsOf(keyId: string): KeyCalls {
    let c = this.calls.get(keyId);
    if (!c) {
      c = { keyId, requests: 0, ok: 0, failures: 0, lastOkAt: null, lastErrorAt: null, lastError: null, lastStatus: null, lastOutcome: null, check: null };
      this.calls.set(keyId, c);
    }
    return c;
  }

  private noteOk(keyId: string): void {
    const c = this.callsOf(keyId);
    c.requests++;
    c.ok++;
    c.lastOkAt = Date.now();
    c.lastStatus = 200;
    c.lastOutcome = "ok";
  }

  private noteFailure(keyId: string, outcome: KeyOutcome, e: unknown): void {
    const c = this.callsOf(keyId);
    c.requests++;
    c.failures++;
    c.lastErrorAt = Date.now();
    c.lastError = failureText(e);
    c.lastStatus = e instanceof HttpError ? e.status : null;
    c.lastOutcome = outcome;
  }

  /** Runs one request, counting it against its route while it is in flight. */
  private async tracked<T>(proxy: string | null, run: () => Promise<T>): Promise<T> {
    if (proxy === null) return run();
    this.inFlight.set(proxy, (this.inFlight.get(proxy) ?? 0) + 1);
    try {
      return await run();
    } finally {
      this.inFlight.set(proxy, (this.inFlight.get(proxy) ?? 1) - 1);
    }
  }

  /** True when every key sits out (rejected, out of quota, throttled, or its route is down). */
  get keysBenched(): boolean {
    return this.ring.benched() >= this.ring.size;
  }

  /** Whether any key may still ask for trending narratives. */
  get narrativesAvailable(): boolean {
    return this.ring.keyIds.some((id) => !this.gated.has(id));
  }

  /** Tokens with the most mentions in the window, `$` stripped. */
  async trendingTokens(timeWindow = "24h", minMentions = 5, pageSize = 50, wait = false): Promise<TrendingToken[]> {
    const json = await this.get<{ success?: boolean; data?: { data?: Array<Record<string, unknown>> } }>(
      "/v2/aggregations/trending-tokens",
      { timeWindow, minMentions, page: 1, pageSize },
      1,
      { wait },
    );
    if (json.success !== true || !Array.isArray(json.data?.data)) throw new Error("elfa: malformed trending-tokens response");
    const out: TrendingToken[] = [];
    for (const row of json.data.data) {
      const { token, current_count: current, previous_count: previous, change_percent: change } = row;
      if (typeof token !== "string" || typeof current !== "number" || typeof previous !== "number") continue;
      out.push({
        token: token.replace(/^\$/, ""),
        currentCount: current,
        previousCount: previous,
        changePercent: typeof change === "number" && Number.isFinite(change) ? change : 0,
      });
    }
    return out;
  }

  /**
   * Themes trending across X today (or this week), with source posts. Paid-only: throws PlanError
   * without asking when no key may call it, and a plan refusal is never retried on another key.
   */
  async trendingNarratives(timeFrame: "day" | "week" = "day", maxNarratives = 10, wait = false): Promise<Narrative[]> {
    if (!this.narrativesAvailable) throw new PlanError("trending narratives");
    const json = await this.get<{ success?: boolean; data?: { trending_narratives?: Array<Record<string, unknown>> } }>(
      "/v2/data/trending-narratives",
      { timeFrame, maxNarratives },
      5,
      { paidOnly: "trending narratives", wait },
    );
    const rows = json.data?.trending_narratives;
    if (json.success !== true || !Array.isArray(rows)) throw new Error("elfa: malformed trending-narratives response");
    return rows
      .filter((r): r is { narrative: string; source_links?: unknown } => typeof r.narrative === "string" && r.narrative.length > 0)
      .map((r) => ({
        narrative: r.narrative,
        links: Array.isArray(r.source_links) ? r.source_links.filter((l): l is string => typeof l === "string") : [],
      }));
  }

  /** Mentions of any keyword in [fromSec, toSec]; Elfa caps the total at 10,000. */
  async mentions(keywords: readonly string[], fromSec: number, toSec: number, wait = false): Promise<number> {
    if (keywords.length === 0) throw new Error("elfa: no keywords");
    if (toSec - fromSec < MIN_MENTIONS_WINDOW_SEC) throw new Error("elfa: keyword-mentions windows must span at least one day");
    const json = await this.get<{ success?: boolean; metadata?: { total?: unknown } }>(
      "/v2/data/keyword-mentions",
      { keywords: keywords.slice(0, 5).join(","), from: fromSec, to: toSec, limit: 1, searchType: "or" },
      1,
      { wait },
    );
    const total = json.metadata?.total;
    if (json.success !== true || typeof total !== "number" || !Number.isFinite(total) || total < 0) {
      throw new Error("elfa: malformed keyword-mentions response");
    }
    return total;
  }

  /** One key's status, through its route. */
  async keyStatus(key: string, keyId: string): Promise<KeyStatus> {
    const proxy = this.proxyFor(keyId);
    if (proxy === null && this.requireProxy) throw new Error("elfa: this key has no proxy of its own");
    const url = `${this.baseUrl}/v2/key-status`;
    const via = elfaProxy(this.host, url, proxy);
    const call = () => {
      this.pacer?.used(keyId);
      return this.tracked(proxy, () => fetchJson<unknown>(this.fetchImpl, "elfa", url, { headers: { "x-elfa-api-key": key, accept: "application/json" }, ...via }));
    };
    const json = await (this.pacer ? this.pacer.run(call, true) : call());
    const status = parseKeyStatus(json);
    this.noteOk(keyId);
    this.callsOf(keyId).check = { ...status, at: Date.now() };
    return status;
  }

  /**
   * Brings the ring's monthly usage up to what Elfa reports for each key (one credit per key),
   * notes each key's plan (a free key never asks for paid-only endpoints), benches keys Elfa
   * rejects, and rests keys whose route failed. Returns the ids of the rejected and failed keys.
   */
  async syncUsage(keys: readonly { key: string; keyId: string }[]): Promise<{ rejected: string[]; failed: string[] }> {
    const checks = await this.checkKeys(keys);
    const unexpected = checks.find((c) => c.outcome === "error" || c.outcome === "quota" || c.outcome === "throttled" || c.outcome === "plan");
    if (unexpected) throw new Error(unexpected.error ?? "elfa: key status failed");
    return { rejected: checks.filter((c) => c.outcome === "rejected").map((c) => c.keyId), failed: checks.filter((c) => c.outcome === "route-down" || c.outcome === "route-auth").map((c) => c.keyId) };
  }

  /**
   * Asks Elfa for every key's status (one credit each), one key at a time with a gap between keys,
   * acts on the answers as syncUsage does, and reports each key's outcome as it lands (`onResult`)
   * and at the end. Never throws for one key's failure.
   */
  async checkKeys(keys: readonly { key: string; keyId: string }[], onResult?: (done: readonly KeyCheck[]) => void): Promise<KeyCheck[]> {
    const out: KeyCheck[] = [];
    const [lo, hi] = this.pacing.checkGapMs ?? [0, 0];
    for (const [n, { key, keyId }] of keys.entries()) {
      if (n > 0 && hi > 0) await this.sleep(lo + (this.pacing.random ?? Math.random)() * (hi - lo));
      if (n > 0) onResult?.(out);
      const empty = { keyId, plan: null, free: null, usedThisMonth: null, monthlyLimit: null, remaining: null };
      try {
        const status = await this.keyStatus(key, keyId);
        if (status.usedThisMonth !== null) await this.ring.syncMonth(keyId, status.usedThisMonth);
        if (status.free === true) this.gated.add(keyId);
        if (status.free === false) this.paid.add(keyId);
        out.push({ ...empty, ...status, outcome: "ok", status: 200, error: null });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : null;
        if (isKeyRejected(e)) {
          this.ring.reject(keyId);
          this.noteFailure(keyId, "rejected", e);
          out.push({ ...empty, outcome: "rejected", status, error: failureText(e) });
          continue;
        }
        const proxy = this.proxyFor(keyId) !== null ? proxyFailure(e) : null;
        if (proxy !== null) {
          const outcome = proxy === "auth" ? "route-auth" : "route-down";
          this.ring.rest(keyId, proxy === "auth" ? PROXY_AUTH_REST_MS : PROXY_REST_MS, outcome);
          this.noteFailure(keyId, outcome, e);
          out.push({ ...empty, outcome, status, error: failureText(e) });
          continue;
        }
        const outcome: KeyOutcome = isQuotaError(e) ? "quota" : isThrottled(e) ? "throttled" : "error";
        this.noteFailure(keyId, outcome, e);
        out.push({ ...empty, outcome, status, error: failureText(e) });
      }
    }
    onResult?.(out);
    return out;
  }

  /**
   * One paid call: reserves credits, and moves to the next key when Elfa refuses one for quota or
   * rejects it, or when the key's route fails. A paid-only endpoint refused for plan stops at once.
   */
  private async get<T>(path: string, params: Record<string, string | number | undefined>, cost: number, opts: { paidOnly?: string; wait?: boolean } = {}): Promise<T> {
    const eligible = (id: string) => (!opts.paidOnly || !this.gated.has(id)) && (!this.requireProxy || this.proxyFor(id) !== null);
    const pacer = this.pacer;
    let waited = 0;
    for (let attempt = 0; attempt < this.ring.size; ) {
      if (pacer && !opts.wait) {
        const due = pacer.waitMs();
        if (due > 0) throw new PacedError("elfa", due);
      }
      const lease = await this.ring.take(cost, (id) => eligible(id) && (pacer?.keyReady(id) ?? true), pacer ? this.weighted : undefined);
      if (!lease) {
        // A key with credits may only be resting from its last use: wait for it, or say when.
        const resting = pacer ? await this.restingKeys(cost, eligible) : [];
        if (resting.length === 0) throw new BudgetError("elfa");
        const waitMs = Math.max(1, Math.min(...resting.map((id) => pacer!.keyWaitMs(id))));
        if (!opts.wait || waited + waitMs > MAX_KEY_WAIT_MS) throw new PacedError("elfa", waitMs);
        waited += waitMs;
        await this.sleep(waitMs);
        continue;
      }
      attempt++;
      const proxy = this.proxyFor(lease.keyId);
      const url = `${this.baseUrl}${path}?${query(params)}`;
      const via = elfaProxy(this.host, url, proxy);
      const call = () => {
        pacer?.used(lease.keyId);
        return this.tracked(proxy, () => fetchJson<T>(this.fetchImpl, "elfa", url, { headers: { "x-elfa-api-key": lease.key, accept: "application/json" }, ...via }));
      };
      try {
        const json = await (pacer ? pacer.run(call, true) : call());
        this.noteOk(lease.keyId);
        return json;
      } catch (e) {
        const failure = proxy ? proxyFailure(e) : null;
        if (failure) {
          const outcome = failure === "auth" ? "route-auth" : "route-down";
          this.ring.rest(lease.keyId, failure === "auth" ? PROXY_AUTH_REST_MS : PROXY_REST_MS, outcome);
          this.noteFailure(lease.keyId, outcome, e);
        } else if (opts.paidOnly && isPlanGated(e)) {
          // A plan refusal: every key not known to be paid stops asking.
          for (const id of this.ring.keyIds) if (!this.paid.has(id)) this.gated.add(id);
          this.gated.add(lease.keyId);
          this.noteFailure(lease.keyId, "plan", e);
          throw new PlanError(opts.paidOnly);
        } else if (isKeyRejected(e)) {
          this.ring.reject(lease.keyId);
          this.noteFailure(lease.keyId, "rejected", e);
        } else if (isQuotaError(e)) {
          this.ring.exhaust(lease.keyId);
          this.noteFailure(lease.keyId, "quota", e);
        } else if (isThrottled(e)) {
          this.ring.rest(lease.keyId);
          this.noteFailure(lease.keyId, "throttled", e);
        } else {
          this.noteFailure(lease.keyId, "error", e);
          throw e;
        }
      }
    }
    throw new BudgetError("elfa");
  }

  /** Keys with credits for `cost` that are only resting from their last use. */
  private async restingKeys(cost: number, eligible: (id: string) => boolean): Promise<string[]> {
    const pacer = this.pacer;
    if (!pacer) return [];
    const benched = new Set(this.ring.benches().map((b) => b.keyId));
    return (await this.ring.usage()).filter((u) => u.left >= cost && !benched.has(u.keyId) && eligible(u.keyId) && !pacer.keyReady(u.keyId)).map((u) => u.keyId);
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

/**
 * Reads `/v2/key-status` leniently: the plan name, month-to-date usage, the monthly limit and
 * what is left, wherever the answer puts them. A plan is free when its name says so, or, unnamed,
 * when its monthly limit is the free tier's 1,000 credits or less.
 */
export function parseKeyStatus(json: unknown): KeyStatus {
  const root = (json ?? {}) as Record<string, unknown>;
  const d = ((root.data && typeof root.data === "object" ? root.data : root) ?? {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const usage = obj(d.usage);
  const limits = obj(d.limits);
  const sub = obj(d.subscription);
  const plan = str(d.plan) ?? str(d.planName) ?? str(d.tier) ?? str(sub.plan) ?? str(sub.name) ?? str(obj(d.plan).name) ?? str(obj(d.key).plan);
  const usedThisMonth = num(usage.monthly) ?? num(d.monthlyUsage);
  const monthlyLimit = num(d.monthlyRequestLimit) ?? num(d.monthlyLimit) ?? num(limits.monthly) ?? num(usage.monthlyLimit) ?? num(d.monthlyCreditLimit);
  const remaining = num(d.remaining) ?? num(d.remainingCredits) ?? num(obj(d.credits).remaining) ?? (monthlyLimit !== null && usedThisMonth !== null ? Math.max(0, monthlyLimit - usedThisMonth) : null);
  let free: boolean | null = null;
  if (plan && /free|trial|hobby|starter|basic/i.test(plan)) free = true;
  else if (plan && /pro|paid|premium|enterprise|business|growth|scale|grow/i.test(plan)) free = false;
  else if (monthlyLimit !== null) free = monthlyLimit <= 1_000;
  return { plan, free, usedThisMonth, monthlyLimit, remaining };
}
