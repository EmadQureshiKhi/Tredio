import type { Checkpoint, Deployment, Network, Trend } from "@tredio/contracts";
import { explorerAccount, indexPoints } from "@tredio/contracts";
import { type ChainViews, checkReview, type ReviewEvidence, type TxIndex, verifyIndex } from "@tredio/mcp";
import type { Readings } from "@tredio/oracle/src/method";
import { breakdown } from "./components";
import { type AttentionResult, RESULT_SCHEMA_ID } from "./result";
import { type ApiCandidate, type ApiTrend, type Resolution, resolve } from "./topic";

/**
 * Builds an attention check: resolves a brief's topic against Tredio's public API and assembles
 * the answer from three places that vouch for themselves: the registry contract (read over NEAR
 * RPC, the account from `@tredio/contracts`'s deployment), the oracle report behind its newest
 * checkpoint (`verifyIndex`), and the NEAR AI Cloud review evidence (`checkReview`).
 */

/** JSON over HTTP from Tredio's API (`TredioApi` of `@tredio/mcp` fits). */
export interface ApiReader {
  get<T>(path: string): Promise<T>;
}

interface TrendDetail {
  trend: ApiTrend;
  index: Array<{ t: number; v: number }>;
  relistedAs: string | null;
}

interface ReviewResponse {
  hash: string;
  evidence: ReviewEvidence;
  request?: string | null;
  response?: string | null;
  createdAt: string;
}

export interface CheckerOptions {
  api: ApiReader;
  chain: ChainViews;
  /** Finds the oracle report behind a checkpoint; null skips that check. */
  txIndex: TxIndex | null;
  deployment: Deployment;
  network: Network;
  /** The API as callers reach it, for the verification links. */
  publicApiUrl: string;
  appUrl: string;
  /** How long the oracle report search may take before the answer goes without it. */
  reportTimeoutMs?: number;
  now?: () => number;
}

const DAY = 86_400;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** A slow or failed optional read becomes `fallback` (with the reason), never a failed answer. */
async function within<T>(p: Promise<T>, ms: number, fallback: (reason: string) => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback(`no answer within ${Math.round(ms / 1000)} s`)), ms)))]);
  } catch (e) {
    return fallback(String((e as Error).message ?? e).slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
}

/** The last 24 hours of an index series: change, range and one value an hour (the hour's last checkpoint, carried forward). */
export function window24h(points: ReadonlyArray<{ t: number; v: number }>, nowSec: number): Pick<NonNullable<AttentionResult["index"]>, "change24h" | "min24h" | "max24h" | "checkpoints24h" | "series24h"> {
  const pts = [...points].sort((a, b) => a.t - b.t);
  const from = nowSec - DAY;
  const inside = pts.filter((p) => p.t > from && p.t <= nowSec);
  const opening = [...pts].reverse().find((p) => p.t <= from) ?? inside[0] ?? null;
  const latest = inside.at(-1) ?? opening;
  const series: Array<{ t: number; v: number }> = [];
  let i = 0;
  let last: number | null = null;
  for (const p of pts) if (p.t <= from) last = p.v;
  while (i < pts.length && pts[i]!.t <= from) i++;
  for (let h = 1; h <= 24; h++) {
    const end = from + h * 3600;
    while (i < pts.length && pts[i]!.t <= end) last = pts[i++]!.v;
    if (last !== null) series.push({ t: end, v: last });
  }
  const values = inside.map((p) => p.v);
  return {
    change24h: opening && latest ? { from: opening.v, to: latest.v, pct: opening.v > 0 ? round2(((latest.v - opening.v) / opening.v) * 100) : null, since: opening.t } : null,
    min24h: values.length ? Math.min(...values) : null,
    max24h: values.length ? Math.max(...values) : null,
    checkpoints24h: inside.length,
    series24h: series,
  };
}

export class AttentionChecker {
  private readonly now: () => number;
  /** The live trends of the last resolve, for a decline that suggests what to ask instead. */
  private live: string[] = [];

  constructor(private readonly o: CheckerOptions) {
    this.now = o.now ?? Date.now;
  }

  private get registry(): string {
    return this.o.deployment.contracts.registry;
  }

  /** The topic the queries name, or null when Tredio neither lists it nor has it on the radar. */
  async resolve(queries: readonly string[]): Promise<Resolution | null> {
    if (queries.length === 0) return null;
    const [trends, radar] = await Promise.all([
      this.o.api.get<{ trends: ApiTrend[] }>("/v1/trends?all=1"),
      // The radar is a fallback: without it, listed trends still resolve.
      this.o.api.get<{ candidates: ApiCandidate[]; slots?: { live: number; max: number } }>("/v1/candidates").catch(() => ({ candidates: [] as ApiCandidate[], slots: undefined })),
    ]);
    this.live = trends.trends.filter((t) => t.status === "active" || t.status === "cooling").map((t) => (t.displayName ? `${t.displayName} (${t.identifier})` : t.identifier));
    return resolve(queries, trends.trends, { candidates: radar.candidates, slots: radar.slots ?? null });
  }

  suggestions(): string[] {
    return this.live;
  }

  async check(r: Resolution): Promise<AttentionResult> {
    return r.kind === "trend" ? this.listed(r) : this.candidate(r);
  }

  private async listed(r: Extract<Resolution, { kind: "trend" }>): Promise<AttentionResult> {
    const nowSec = Math.floor(this.now() / 1000);
    const notes: string[] = [];
    let detail = await this.o.api.get<TrendDetail>(`/v1/trends/${encodeURIComponent(r.trend.identifier)}`);
    let relistedFrom: string | null = null;
    if (detail.trend.status === "retired" && detail.relistedAs) {
      relistedFrom = detail.trend.identifier;
      detail = await this.o.api.get<TrendDetail>(`/v1/trends/${encodeURIComponent(detail.relistedAs)}`);
      notes.push(`${relistedFrom} retired; its topic listed again as ${detail.trend.identifier}, which this answer reads.`);
    }
    const t = detail.trend;
    const id = t.identifier;
    const verifyReport = this.o.txIndex !== null;
    const [onChainTrend, history, review, report] = await Promise.all([
      this.o.chain.view<Trend | null>(this.registry, "get_trend", { id }).catch(() => undefined),
      this.o.chain.view<Checkpoint[]>(this.registry, "history", { id }).catch(() => undefined),
      t.reviewHash ? this.o.api.get<ReviewResponse>(`/v1/reviews/${t.reviewHash}`).catch((e: unknown) => new Error(String((e as Error).message ?? e))) : Promise.resolve(null),
      verifyReport
        ? within(
            verifyIndex({ identifier: id, chain: this.o.chain, txIndex: this.o.txIndex!, deployment: this.o.deployment, network: this.o.network }),
            this.o.reportTimeoutMs ?? 25_000,
            (reason) => ({ identifier: id, verified: false, reason: `the oracle report search failed: ${reason}`, checkpoint: null, oracle: null }),
          )
        : Promise.resolve(null),
    ]);
    if (onChainTrend === undefined && history === undefined) notes.push("The registry could not be read over NEAR RPC just now; the index comes from Tredio's API alone.");
    else if (onChainTrend === undefined || history === undefined) notes.push(`The registry's ${onChainTrend === undefined ? "get_trend" : "history"} view could not be read over NEAR RPC just now; its fields are empty.`);
    if (t.status === "retired") notes.push(`${id} is retired: its index is the last the oracle reported.`);
    if (t.rotatingOut) notes.push(`${id} is rotating out: its index goes stale on purpose until it retires.`);
    if (!t.reviewHash) notes.push("This trend was listed by an admin by hand, so it carries no NEAR AI review.");
    if (review instanceof Error) notes.push(`The review evidence could not be read: ${review.message}`);
    const last = history?.at(-1) ?? null;
    const checkpoint = last ? { at: last.at, index: indexPoints(last.index), raw: last.index } : null;
    const chainIndex = onChainTrend ? indexPoints(onChainTrend.index) : null;
    const parts = breakdown(t.readings as Readings, t.assetClass === "crypto", nowSec);
    const win = window24h(detail.index, nowSec);
    const api = this.o.publicApiUrl;
    const net = this.o.network;
    return {
      schema: RESULT_SCHEMA_ID,
      query: r.query,
      answeredAt: nowSec,
      network: net,
      match: { status: "listed", how: r.how, alternatives: r.alternatives, relistedFrom },
      topic: {
        identifier: id,
        name: t.displayName,
        summary: t.summary,
        assetClass: t.assetClass,
        status: onChainTrend?.status ?? t.status,
        keywords: t.keywords,
        wikipediaArticle: t.article,
        ticker: t.ticker,
        page: `${this.o.appUrl}/t/${id}`,
      },
      index: {
        now: chainIndex ?? t.index,
        peak: onChainTrend ? indexPoints(onChainTrend.peak_index) : t.peakIndex,
        updatedAt: onChainTrend?.updated_at ?? t.updatedAt,
        ...win,
      },
      sources: parts.sources,
      recomputed: {
        points: parts.points,
        note: "Recomputed now from the latest readings with the oracle's method (apps/oracle/docs/index-method.md); the registry's value differs when readings arrived after its checkpoint or its per-update move limit (max_move_bps) spread a step over several reports.",
      },
      onChain:
        onChainTrend === undefined && history === undefined
          ? null
          : {
              registry: this.registry,
              trend: onChainTrend
                ? { status: onChainTrend.status, index: indexPoints(onChainTrend.index), peak: indexPoints(onChainTrend.peak_index), updatedAt: onChainTrend.updated_at, fresh: onChainTrend.fresh, reviewHash: onChainTrend.review_hash }
                : null,
              checkpoint,
              checkpoints: history?.length ?? 0,
              matchesApi: chainIndex !== null && Math.abs(chainIndex - t.index) < 0.005,
              oracleReport: report
                ? {
                    verified: report.verified,
                    reason: report.reason ?? null,
                    transaction: report.report?.transaction ?? null,
                    explorer: report.report?.explorer ?? null,
                    runId: report.report?.runId ?? null,
                    oracleKey: report.oracle?.publicKey ?? null,
                    checks: report.checks ?? null,
                  }
                : null,
              verify: [
                `near contract call-function as-read-only ${this.registry} history json-args '{"id":"${id}"}' network-config ${net} now`,
                `The last checkpoint is {at, index}; index / 1000000 is the points above. get_trend on the same contract gives status, peak and the review hash (${explorerAccount(net, this.registry)}).`,
                "The oracle report: the registry transaction's submit_report args carry report_json and an ed25519 signature over SHA-256(report_json) by get_oracle's tee_signer.public_key; its observed_at is the checkpoint's time (Tredio's MCP tool verify_index runs this check).",
              ],
            },
      review:
        review && !(review instanceof Error)
          ? this.reviewJson(review, onChainTrend?.review_hash, api)
          : null,
      radar: null,
      notes,
    };
  }

  private reviewJson(r: ReviewResponse, onChainHash: string | null | undefined, api: string): NonNullable<AttentionResult["review"]> {
    const bodies = typeof r.request === "string" && typeof r.response === "string" ? { request: r.request, response: r.response } : null;
    const c = checkReview(r.hash, r.evidence, bodies);
    const e = r.evidence;
    return {
      hash: r.hash,
      url: `${api}/v1/reviews/${r.hash}`,
      onChainHashMatches: onChainHash === undefined ? null : onChainHash === r.hash,
      provider: e.provider,
      model: e.model,
      signatureKind: e.signatureKind,
      signingAlgo: e.signingAlgo,
      signingAddress: e.signingAddress,
      verifyUrl: e.verifyUrl,
      createdAt: r.createdAt,
      checks: { hashMatches: c.hashMatches, signatureMatchesSigner: c.signatureMatchesSigner, bodiesMatch: c.bodies ? c.bodies.ok : null },
      verified: c.hashMatches && c.signatureMatchesSigner && c.bodies?.ok === true,
      verify: [
        `GET ${api}/v1/reviews/${r.hash}: the SHA-256 of the evidence object as JSON with its keys sorted is the review hash, the same review_hash the registry's get_trend returns.`,
        `The signature (${e.signingAlgo}) is ${e.signingAddress}'s over signedText, which is ${e.signatureKind === "provider_tee" ? "<model>:" : ""}<sha256(request)>:<sha256(response)> of the exact request and response bodies served beside it.`,
        `The signing key's TEE attestation is at ${e.verifyUrl} (NEAR AI Cloud).`,
      ],
    };
  }

  private async candidate(r: Extract<Resolution, { kind: "candidate" }>): Promise<AttentionResult> {
    const c = r.candidate;
    return {
      schema: RESULT_SCHEMA_ID,
      query: r.query,
      answeredAt: Math.floor(this.now() / 1000),
      network: this.o.network,
      match: { status: "candidate", how: r.how, alternatives: r.alternatives, relistedFrom: null },
      topic: { identifier: c.identifier, name: c.displayName, summary: c.summary, assetClass: c.assetClass, status: "on_radar", keywords: c.keywords, wikipediaArticle: c.article, ticker: c.ticker, page: `${this.o.appUrl}/radar` },
      index: null,
      sources: [],
      recomputed: null,
      onChain: null,
      review: null,
      radar: { queue: c.queue, slots: r.slots, signal: c.signal, readings: c.readings, watchers: c.watchers, source: c.source, attribution: c.attribution },
      notes: [`${c.identifier} is on Tredio's radar but not listed: the oracle writes its first index when it takes a live slot, and its review travels with that listing. Readings are the radar's latest measurements.`],
    };
  }
}
