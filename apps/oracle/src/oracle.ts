import type { Sender, Viewer } from "@tredio/chain";
import { calls, type Deployment, type Report, type Trend } from "@tredio/contracts";
import type { HyperliquidInfo } from "@tredio/hyperliquid";
import { type Method, measure, type Readings } from "./method";
import { allocate, assetClassOf, baseOf, type Candidate, decide, freeListing, type LiveTrend } from "./plan";
import type { ReportSigner } from "./signer";

export interface OracleOptions {
  backendUrl: string;
  backendToken: string;
  maxSamplesPerRun: number;
  maxCandidatesPerRun: number;
  maxLiveTrends: number;
  heartbeatSec: number;
  deviationBps: number;
  minCreateIndexPoints: number;
  /** Hyperliquid assets whose marks every report carries (the account contract's order guard reads them). */
  markAssets: readonly string[];
  method: Method;
}

export interface RunResult {
  runId: number;
  sampled: number;
  created: string[];
  updated: number;
  marks: number;
  tx: string | null;
  skipped?: string;
}

const PAGE = 100;

/**
 * One oracle run: read the candidate queue and the live trends, measure a sample through the
 * collector, decide what changed enough to report, add Hyperliquid marks, sign the report and
 * submit it. A run with nothing to report and no marks sends nothing.
 */
export class Oracle {
  lastRun: (RunResult & { at: number }) | null = null;
  lastError: string | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly sender: Sender,
    private readonly signer: ReportSigner,
    private readonly hyperliquid: HyperliquidInfo,
    private readonly d: Deployment,
    private readonly o: OracleOptions,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (fields: Record<string, unknown>, msg: string) => void = () => {},
  ) {}

  private async backend<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.o.backendUrl}${path}`, { headers: { authorization: `Bearer ${this.o.backendToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`backend ${path.split("?")[0]}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async trends(): Promise<Trend[]> {
    const out: Trend[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = await this.viewer.view<Trend[]>(this.d.contracts.registry, "get_trends", { from_index: from, limit: PAGE });
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  async run(nowSec = Math.floor(Date.now() / 1000)): Promise<RunResult> {
    const observedAt = nowSec;
    const [all, queue, lastRunId, hlMarkets] = await Promise.all([
      this.trends(),
      this.backend<{ candidates: Array<{ identifier: string; surfacer?: string; ticker?: string | null; reviewHash?: string | null; pinned?: boolean; pick?: boolean }>; rotating: string[] }>("/v1/oracle/candidates").catch((e: Error) => {
        this.log({ err: e.message }, "candidate queue unavailable");
        return { candidates: [], rotating: [] };
      }),
      this.viewer.view<number>(this.d.contracts.registry, "last_run_id"),
      this.hyperliquid.perpMarkets().catch(() => []),
    ]);
    const runId = Math.max(observedAt, lastRunId + 1);
    const byId = new Map(all.map((t) => [t.id, t]));
    // Trends rotating out are left unmeasured on purpose (the registry retires them as stale).
    const rotating = new Set(queue.rotating);
    const liveTrends = all.filter((t) => t.status !== "retired" && !rotating.has(t.id));
    const live: LiveTrend[] = await Promise.all(
      liveTrends.map(async (t) => {
        const pending = await this.viewer.view<number[]>(this.d.contracts.registry, "pending_expiries", { id: t.id }).catch(() => []);
        return { ...t, pendingDue: pending.filter((e) => e <= observedAt).length };
      }),
    );
    const liveCount = all.filter((t) => t.status !== "retired").length;
    const liveBases = new Set(all.filter((t) => t.status !== "retired").map((t) => baseOf(t.id)));
    const candidates: Candidate[] = queue.candidates
      .filter((c) => !liveBases.has(baseOf(c.identifier)))
      .map((c) => ({ identifier: baseOf(c.identifier), surfacer: c.surfacer ?? null, ticker: c.ticker ?? null, reviewHash: c.reviewHash ?? null, pinned: c.pinned === true, pick: c.pick === true }));
    // Kept topics first, then community picks, then the queue as ranked.
    const ordered = [...candidates.filter((c) => c.pinned), ...candidates.filter((c) => !c.pinned && c.pick), ...candidates.filter((c) => !c.pinned && !c.pick)];
    const sample = allocate(live, ordered, this.o.maxSamplesPerRun, this.o.maxCandidatesPerRun, this.o.maxLiveTrends - liveCount);

    const listings = sample.candidates.flatMap((c) => {
      const id = freeListing(c.identifier, (x) => byId.get(x)?.status ?? null);
      return id ? [{ candidate: c, identifier: id }] : [];
    });
    const bases = [...new Set([...sample.trends.map((t) => baseOf(t.id)), ...listings.map((l) => l.candidate.identifier)])];
    const measured =
      bases.length === 0
        ? { trends: {} as Record<string, { readings: Readings }> }
        : await this.backend<{ trends: Record<string, { readings: Readings }> }>(`/v1/oracle/measurements?ids=${encodeURIComponent(bases.join(","))}`).catch((e: Error) => {
            // Without measurements nothing is updated (an old value is never re-reported), but marks still go out.
            this.log({ err: e.message }, "measurements unavailable");
            return { trends: {} as Record<string, { readings: Readings }> };
          });
    const m = (identifier: string) => measure(measured.trends[baseOf(identifier)]?.readings ?? {}, assetClassOf(identifier) === "crypto", observedAt, this.o.method);

    const decided = decide(
      sample.trends.map((trend) => ({ trend, m: m(trend.id) })),
      listings.map((l) => ({ ...l, m: m(l.identifier) })),
      {
        now: observedAt,
        heartbeatSec: this.o.heartbeatSec,
        deviationBps: this.o.deviationBps,
        minCreateIndexPoints: this.o.minCreateIndexPoints,
        minConfirmNetflowUsd: this.o.method.nansen.minConfirmNetflowUsd,
        hyperliquidAssets: new Set(hlMarkets.map((x) => x.symbol.toUpperCase())),
      },
    );
    // Marks for the guard's assets and every live trend's own asset, from Hyperliquid's mark price.
    const wanted = new Set([...this.o.markAssets, ...all.flatMap((t) => (t.status !== "retired" && t.asset ? [t.asset] : [])), ...decided.new_trends.flatMap((n) => (n.asset ? [n.asset] : []))]);
    const marks = hlMarkets.filter((x) => wanted.has(x.symbol.toUpperCase()) && x.markPx > 0).map((x) => ({ asset: x.symbol.toUpperCase(), price: Math.round(x.markPx * 1e8).toString() }));

    const result: RunResult = { runId, sampled: sample.trends.length + listings.length, created: decided.new_trends.map((n) => n.identifier), updated: decided.updates.length, marks: marks.length, tx: null };
    if (decided.new_trends.length === 0 && decided.updates.length === 0 && marks.length === 0) {
      this.lastRun = { ...result, skipped: "nothing to report", at: nowSec };
      return this.lastRun;
    }
    const report: Report = { run_id: runId, observed_at: observedAt, new_trends: decided.new_trends, updates: decided.updates, marks };
    const json = JSON.stringify(report);
    const signature = await this.signer.sign(json);
    const sent = await this.sender.send(calls(this.d).registry.submitReport(json, signature));
    result.tx = sent.hash;
    this.lastRun = { ...result, at: nowSec };
    this.lastError = null;
    this.log({ runId, created: result.created, updated: result.updated, marks: result.marks, tx: sent.hash }, "report submitted");
    return result;
  }
}
