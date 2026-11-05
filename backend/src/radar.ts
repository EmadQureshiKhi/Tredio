import { createHash } from "node:crypto";
import { type Assessment, assess, type Signal, verdict } from "./ai/assess";
import type { Ai } from "./ai/providers";
import type { Log } from "./log";
import type { Bluesky, BlueskyTrend } from "./sources/bluesky";
import { COINGECKO_ATTRIBUTION, type CoinGecko } from "./sources/coingecko";
import { type Elfa, PlanError } from "./sources/elfa";
import type { GeckoTerminal } from "./sources/geckoterminal";
import { BudgetError } from "./sources/http";
import { lastCompleteDay, type Wikipedia } from "./sources/wikipedia";
import { type CandidateSource, type CandidateStatus, type Store, RADAR_SURFACER } from "./store";

/**
 * The trend radar. Each run reads crypto seeds (Elfa's trending tokens, CoinGecko's most-searched
 * coins and GeckoTerminal's trending pools, deduplicated by ticker) and Bluesky's trending topics;
 * less often Elfa's trending narratives (paid keys only) and, once a day, Wikipedia's most-read
 * articles. Signals not seen recently are assessed by the AI in batches and stored as candidates. Policy-clean, confident proposals are approved for the oracle;
 * the rest wait for a reviewer or are rejected. The radar only proposes: the oracle
 * measures each candidate and decides whether it becomes a trend.
 */

export interface RadarConfig {
  narrativesEvery: number;
  /** Radar runs between Elfa trending-token calls (1 credit each); raise it on a small budget. Default 1. */
  tokensEvery?: number;
  autoApproveConfidence: number;
  /** Trending tokens need at least this many mentions in 24h. */
  minTokenMentions: number;
  maxTokens: number;
  /** Narratives per run, from Elfa and from Bluesky's trending topics each. */
  maxNarratives: number;
  maxArticles: number;
  /** CoinGecko's most-searched coins per run. */
  maxCoins: number;
  /** GeckoTerminal's trending pools per run, after the volume and liquidity floors. */
  maxPools: number;
  minPoolVolumeUsd: number;
  minPoolReserveUsd: number;
  /** A signal is assessed again after this long. */
  reassessSec: number;
  batchSize: number;
  /** Tickers that always get a look when they trend (the ones with asset perps, so their cards can trade them). */
  priorityTickers?: () => Promise<string[]>;
}

export const DEFAULT_RADAR: Omit<RadarConfig, "narrativesEvery" | "autoApproveConfidence"> = {
  minTokenMentions: 20,
  maxTokens: 12,
  maxNarratives: 8,
  maxArticles: 20,
  maxCoins: 8,
  maxPools: 4,
  minPoolVolumeUsd: 1_000_000,
  minPoolReserveUsd: 100_000,
  reassessSec: 7 * 86_400,
  batchSize: 8,
};

export interface RadarReport {
  run: number;
  signals: number;
  assessed: number;
  approved: number;
  pending: number;
  rejected: number;
  provider: string | null;
  skipped: string[];
}

interface Keyed {
  key: string;
  source: CandidateSource;
  signal: Signal;
}

/**
 * Sources whose proposals always wait for a reviewer, however confident the AI: anyone signed in
 * can submit a link, and the page it points at is written by whoever wants the market.
 */
export const REVIEWED_SOURCES: ReadonlySet<CandidateSource> = new Set(["link"]);

/** Credit a source's terms require wherever its candidates are shown. */
export const SOURCE_ATTRIBUTION: Partial<Record<CandidateSource, { text: string; url: string }>> = {
  coingecko_trending: COINGECKO_ATTRIBUTION,
  geckoterminal_trending: { text: "Data from GeckoTerminal", url: "https://www.geckoterminal.com" },
};

/** Free sources the radar reads besides Elfa and Wikipedia; each is optional. */
export interface RadarFeeds {
  bluesky?: Bluesky | null;
  coingecko?: CoinGecko | null;
  geckoterminal?: GeckoTerminal | null;
}

/** Rising topics first, then the busiest. */
const TREND_STATUS_RANK: Record<string, number> = { hot: 0, trending: 1, cooling: 2 };
const byHeat = (a: BlueskyTrend, b: BlueskyTrend) =>
  (TREND_STATUS_RANK[a.status ?? ""] ?? 3) - (TREND_STATUS_RANK[b.status ?? ""] ?? 3) || b.postCount - a.postCount;
const TICKER = /^[A-Za-z0-9]{1,15}$/;

const hash = (s: string) => createHash("sha256").update(s.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

export class Radar {
  private run = 0;
  private wikipediaDay: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly elfa: Elfa | null,
    private readonly wikipedia: Wikipedia,
    private readonly ai: Ai,
    private readonly cfg: RadarConfig,
    private readonly log: Log,
    private readonly feeds: RadarFeeds = {},
  ) {}

  async tick(now = Date.now()): Promise<RadarReport> {
    const run = this.run++;
    const report: RadarReport = { run, signals: 0, assessed: 0, approved: 0, pending: 0, rejected: 0, provider: null, skipped: [] };
    if (!this.ai.enabled) {
      report.skipped.push("no AI provider configured");
      return report;
    }
    const keyed: Keyed[] = [];
    // One signal per key: a ticker trending on several lists is assessed once, from the first.
    const add = (k: Keyed) => {
      if (!keyed.some((x) => x.key === k.key)) keyed.push(k);
    };
    const priority = new Set((await this.cfg.priorityTickers?.().catch(() => []) ?? []).map((x) => x.toUpperCase()));

    if (this.elfa && this.elfa.keysBenched) {
      report.skipped.push("elfa: every key is sitting out");
    } else if (this.elfa) {
      // Trending tokens every `tokensEvery` runs: on a small budget the collector's live trends come first.
      if (run % (this.cfg.tokensEvery ?? 1) === 0) {
        try {
          const tokens = (await this.elfa.trendingTokens("24h", this.cfg.minTokenMentions, 50, true)).filter((t) => TICKER.test(t.token));
          const rising = [...tokens].sort((a, b) => b.changePercent - a.changePercent || b.currentCount - a.currentCount).slice(0, this.cfg.maxTokens);
          for (const t of [...tokens.filter((t) => priority.has(t.token.toUpperCase())), ...rising]) {
            add({
              key: `token:${t.token.toLowerCase()}`,
              source: "elfa_trending",
              signal: { kind: "token", token: t.token, mentions24h: t.currentCount, changePercent: t.changePercent },
            });
          }
        } catch (e) {
          report.skipped.push(`elfa trending: ${message(e)}`);
        }
      }
      // Narratives are paid-only; a free plan leaves them to Bluesky.
      if (run % this.cfg.narrativesEvery === 0 && this.elfa.narrativesAvailable) {
        try {
          for (const n of (await this.elfa.trendingNarratives("day", this.cfg.maxNarratives, true)).slice(0, this.cfg.maxNarratives)) {
            add({ key: `narrative:${hash(n.narrative)}`, source: "elfa_narrative", signal: { kind: "narrative", text: n.narrative, links: n.links.slice(0, 3) } });
          }
        } catch (e) {
          report.skipped.push(`elfa narratives: ${message(e)}`);
        }
      }
    } else {
      report.skipped.push("no Elfa key");
    }

    // CoinGecko's most-searched coins, tickers with asset perps first.
    if (this.feeds.coingecko) {
      try {
        const coins = (await this.feeds.coingecko.trending()).coins.filter((c) => TICKER.test(c.symbol));
        const ordered = [...coins.filter((c) => priority.has(c.symbol)), ...coins.filter((c) => !priority.has(c.symbol))].slice(0, this.cfg.maxCoins);
        for (const c of ordered) {
          add({
            key: `token:${c.symbol.toLowerCase()}`,
            source: "coingecko_trending",
            signal: { kind: "market", source: "coingecko", token: c.symbol, name: c.name, marketCapRank: c.marketCapRank, changePercent: c.priceChange24hPercent, volume24hUsd: null, network: null },
          });
        }
      } catch (e) {
        report.skipped.push(`coingecko trending: ${message(e)}`);
      }
    }

    // GeckoTerminal's trending pools with real volume and liquidity, one per token.
    if (this.feeds.geckoterminal) {
      try {
        const pools = (await this.feeds.geckoterminal.trendingPools())
          .filter((p) => TICKER.test(p.symbol) && p.volume24hUsd >= this.cfg.minPoolVolumeUsd && p.reserveUsd >= this.cfg.minPoolReserveUsd)
          .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
          .filter((p, i, all) => all.findIndex((x) => x.symbol === p.symbol) === i)
          .slice(0, this.cfg.maxPools);
        for (const p of pools) {
          add({
            key: `token:${p.symbol.toLowerCase()}`,
            source: "geckoterminal_trending",
            signal: { kind: "market", source: "geckoterminal", token: p.symbol, name: p.tokenName, marketCapRank: null, changePercent: p.priceChange24hPercent, volume24hUsd: p.volume24hUsd, network: p.network },
          });
        }
      } catch (e) {
        report.skipped.push(`geckoterminal trending: ${message(e)}`);
      }
    }

    // Bluesky's trending topics: the narratives source free Elfa keys cannot read.
    if (this.feeds.bluesky) {
      try {
        const trends = [...(await this.feeds.bluesky.trends())].sort(byHeat).slice(0, this.cfg.maxNarratives);
        for (const t of trends) {
          add({
            key: `bluesky:${hash(t.displayName)}`,
            source: "bluesky_trend",
            signal: { kind: "social", platform: "bluesky", text: t.displayName, description: t.description, postCount: t.postCount, category: t.category, status: t.status, link: t.link },
          });
        }
      } catch (e) {
        report.skipped.push(`bluesky trends: ${message(e)}`);
      }
    }

    // Yesterday's most-read articles, once per day.
    const day = lastCompleteDay(now);
    const dayKey = day.toISOString().slice(0, 10);
    if (this.wikipediaDay !== dayKey) {
      try {
        for (const a of await this.wikipedia.topArticles(day, this.cfg.maxArticles)) {
          add({ key: `wikipedia:${a.article.toLowerCase()}`, source: "wikipedia_top", signal: { kind: "wikipedia", article: a.article, views: a.views, rank: a.rank } });
        }
        this.wikipediaDay = dayKey;
      } catch (e) {
        report.skipped.push(`wikipedia top: ${message(e)}`);
      }
    }

    report.signals = keyed.length;
    const fresh = await this.store.assessedSignals(
      keyed.map((k) => k.key),
      this.cfg.reassessSec,
    );
    const todo = keyed.filter((k) => !fresh.has(k.key));
    for (let i = 0; i < todo.length; i += this.cfg.batchSize) {
      const batch = todo.slice(i, i + this.cfg.batchSize);
      const outcome = await this.assessBatch(batch, report);
      if (!outcome) break;
    }
    return report;
  }

  /** Assesses and stores one batch. Returns false when the AI is unavailable, to stop the run. */
  private async assessBatch(batch: Keyed[], report: RadarReport): Promise<boolean> {
    const existing = await this.store.knownIdentifiers();
    let results: Array<Assessment | null>;
    let reviewHash: string | null = null;
    try {
      const out = await assess(
        this.ai,
        batch.map((b) => b.signal),
        existing,
      );
      results = out.results;
      report.provider = out.provider;
      if (out.evidence) reviewHash = await this.store.saveReview(out.evidence);
    } catch (e) {
      report.skipped.push(`ai: ${message(e)}`);
      return false;
    }
    for (const [i, b] of batch.entries()) {
      const a = results[i];
      if (!a) continue;
      report.assessed++;
      const stored = await this.propose(a, b.source, { signal: b.signal }, RADAR_SURFACER, reviewHash);
      // A topic already listed counts as approved; one that faded stays out, as rejected.
      report[stored.status === "live" ? "approved" : stored.status === "retired" ? "rejected" : stored.status]++;
      await this.store.recordSignal(b.key, b.signal.kind, a.identifier);
    }
    return true;
  }

  /** Stores an assessment as a candidate, with its verdict. Shared with link requests. */
  async propose(
    a: Assessment,
    source: CandidateSource,
    sourceRef: Record<string, unknown>,
    surfacer: string,
    reviewHash: string | null = null,
  ): Promise<{ id: number; identifier: string; status: CandidateStatus; reason: string; created: boolean }> {
    let v = verdict(a, this.cfg.autoApproveConfidence);
    if (v.status === "approved" && REVIEWED_SOURCES.has(source)) v = { status: "pending", reason: `review: ${source} proposals are always reviewed (confidence ${a.confidence.toFixed(2)})` };
    let article = a.article;
    if (article && v.status !== "rejected") {
      article = await this.wikipedia.canonicalTitle(article).catch(() => null);
    }
    const { candidate, created } = await this.store.insertCandidate({
      identifier: a.identifier,
      displayName: a.displayName,
      assetClass: a.assetClass,
      keywords: a.keywords,
      article,
      ticker: a.ticker,
      summary: a.summary,
      source,
      sourceRef,
      surfacer,
      status: v.status,
      confidence: a.confidence,
      ai: { reason: v.reason, policyFlags: a.policyFlags, trendWorthy: a.trendWorthy, duplicateOf: a.duplicateOf },
      decidedBy: v.status === "pending" ? null : "radar",
      reviewHash,
    });
    if (created) this.log.info({ identifier: candidate.identifier, status: candidate.status, reason: v.reason }, "radar proposal");
    return { id: candidate.id, identifier: candidate.identifier, status: candidate.status, reason: created ? v.reason : "already proposed", created };
  }
}

function message(e: unknown): string {
  if (e instanceof BudgetError) return "budget spent for today";
  if (e instanceof PlanError) return "needs a paid plan";
  return e instanceof Error ? e.message.slice(0, 200) : String(e);
}
