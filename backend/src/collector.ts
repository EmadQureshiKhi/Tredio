import type { KeyRing } from "./budget";
import type { ChainReader } from "./chain";
import { assetClassOf, baseOf, CRYPTO, defaultKeywords, defaultName, tickerOf } from "./identifiers";
import type { Log } from "./log";
import { type Bluesky, blueskyQuery } from "./sources/bluesky";
import type { Elfa } from "./sources/elfa";
import type { Gdelt } from "./sources/gdelt";
import { type HackerNews, hnTerms } from "./sources/hackernews";
import type { Nansen } from "./sources/nansen";
import { BudgetError } from "./sources/http";
import { PacedError } from "./sources/pacer";
import type { Wikipedia } from "./sources/wikipedia";
import { rankQueue, READING_MAX_AGE_SEC } from "./queue";
import { pickRotation, type RotationRules } from "./rotation";
import type { Reading, SourceName, Store } from "./store";

/**
 * The measurement collector. API budgets cannot answer the oracle on every run (Elfa's
 * monthly credits, Nansen 10 credits a day, GDELT one request per 5 seconds),
 * and the keyless ones (Bluesky, Hacker News, Wikipedia) ask clients to keep a polite pace, so this
 * loop measures every tracked trend at a pace each source sustains and keeps the latest reading per
 * source; the oracle reads them all in one call and applies the index method.
 *
 * Tracked trends are the registry's live trends plus approved candidates waiting to be listed,
 * including topics back in the queue after their trend retired stale.
 * Each source refreshes the stalest readings first, and the sources run side by side, so a slow
 * one (GDELT spaces its requests 6 to 10 seconds apart) never delays the others. Elfa's refresh interval stretches with the
 * number of trends, so the day's credits last the whole day, and credits are held back for the radar.
 */

/** Time the oracle needs to update a trend again after a rotation is called off, before the registry would retire it. */
const RESUME_MARGIN_SEC = 15 * 60;

export interface CollectorConfig {
  /** Rotation (see rotation.ts); absent, nothing rotates. */
  rotation?: RotationRules & {
    /** A rotation still live after this long is called off (the registry retires a stale trend after 2 h on Testnet). */
    timeoutSec: number;
    /** A new trend must take the slot within this long, or the rotation is called off and the trend stays. */
    listGraceSec: number;
    /** The registry's `staleRetireWindow`: a rotation is called off only while the oracle can still update the trend in time. */
    staleWindowSec: number;
    /** After a rotation is called off, the next one waits this long. */
    cooldownSec: number;
    /** Net smart-money inflow a crypto candidate needs, as the oracle requires. */
    confirmNetflowUsd: number;
  };
  elfaRefreshSec: number;
  gdeltRefreshSec: number;
  nansenRefreshSec: number;
  wikipediaRefreshSec: number;
  /** Elfa credits per day the radar needs (read each tick: it drops once narratives turn out paid-only); the collector leaves them unspent. */
  elfaRadarCreditsPerDay: number | (() => number);
  /** Candidates' GDELT refresh; live trends use gdeltRefreshSec. Defaults to gdeltRefreshSec. */
  gdeltCandidateRefreshSec?: number;
  /** GDELT requests per tick (6 to 10 s apart), live trends first. */
  maxGdeltPerTick: number;
  /** No GDELT request starts this long after the tick's first one (ms), so a slow GDELT never stretches a tick. */
  gdeltTickBudgetMs?: number;
  /** Wikimedia requests per tick, inside Wikimedia's per-minute limit. */
  maxWikipediaPerTick: number;
  /** Bluesky searches: refresh per trend and requests per tick (one per trend, a second apart). */
  blueskyRefreshSec?: number;
  maxBlueskyPerTick?: number;
  /** The oracle's Elfa `maxAgeSec`; the default is READING_MAX_AGE_SEC.elfa. */
  elfaMaxAgeSec?: number;
  /** Hacker News: refresh per trend and trends per tick (up to three requests each). */
  hnRefreshSec?: number;
  maxHnPerTick?: number;
}

export const DEFAULT_BLUESKY_REFRESH_SEC = 1_800;
export const DEFAULT_GDELT_TICK_BUDGET_MS = 40_000;
/** Elfa refreshes a trend within this share of the oracle's age limit, or narrows to live trends. */
export const ELFA_USEFUL_SHARE = 0.75;
export const DEFAULT_HN_REFRESH_SEC = 3_600;

export const MENTIONS_WINDOW_SEC = 86_400;

export interface Tracked {
  /** Base identifier (`topic:x`, never `topic:x.2`); measurements are keyed by it. */
  identifier: string;
  displayName: string;
  assetClass: number;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  live: boolean;
}

export interface CollectorReport {
  tracked: number;
  measured: Partial<Record<SourceName, number>>;
  failed: Partial<Record<SourceName, number>>;
  elfaIntervalSec: number;
  listed: string[];
  /** Topics whose trend the oracle let go stale: back in the queue, to be listed again. */
  requeued: string[];
  /** Topics whose trend faded: out of the queue for good. */
  retired: string[];
  /** The rotation this tick started, finished or is waiting on, if any. */
  rotation: string | null;
  notes: string[];
}

export class Collector {
  /** When GDELT last answered a trend with no timeline: retried at the normal refresh pace, not every tick. */
  private readonly gdeltEmptyAt = new Map<string, number>();
  constructor(
    private readonly store: Store,
    private readonly chain: ChainReader,
    private readonly sources: {
      elfa: { client: Elfa; ring: KeyRing } | null;
      gdelt: Gdelt;
      nansen: Nansen | null;
      wikipedia: Wikipedia;
      bluesky?: Bluesky | null;
      hn?: HackerNews | null;
    },
    private readonly cfg: CollectorConfig,
    private readonly log: Log,
  ) {}

  /** Live trends and approved candidates, with what the sources need to measure them. */
  async tracked(): Promise<Tracked[]> {
    const [trends, meta, approved] = await Promise.all([this.chain.trends(), this.store.trendMeta(), this.store.candidates("approved", 500)]);
    const out = new Map<string, Tracked>();
    for (const t of trends) {
      if (t.status === "Retired" || t.status === "None") continue;
      const base = baseOf(t.identifier);
      const m = meta.get(t.identifier) ?? meta.get(base);
      out.set(base, {
        identifier: base,
        displayName: m?.displayName ?? defaultName(base),
        assetClass: t.assetClass,
        keywords: m?.keywords.length ? m.keywords : defaultKeywords(base),
        article: m?.article ?? null,
        ticker: m?.ticker ?? tickerOf(base),
        live: true,
      });
    }
    for (const c of approved) {
      if (out.has(c.identifier)) continue;
      out.set(c.identifier, {
        identifier: c.identifier,
        displayName: c.displayName,
        assetClass: c.assetClass,
        keywords: c.keywords,
        article: c.article,
        ticker: c.ticker,
        live: false,
      });
    }
    return [...out.values()];
  }

  /** Marks approved candidates live once the oracle listed them, carrying their metadata over. */
  async syncListings(): Promise<string[]> {
    const [trends, approved] = await Promise.all([this.chain.trends(), this.store.candidates("approved", 500)]);
    const listed: string[] = [];
    for (const c of approved) {
      const t = trends.find((x) => baseOf(x.identifier) === c.identifier && x.status !== "Retired" && x.createdAt * 1000 >= c.createdAt.getTime() - 60_000);
      if (!t) continue;
      await this.store.markLive(c, t.identifier, t.id);
      listed.push(t.identifier);
      this.log.info({ identifier: t.identifier }, "candidate listed");
    }
    return listed;
  }

  /**
   * Moves live candidates on once every listing of their topic has retired. A trend retired at
   * least `staleRetireWindow` after its last update was retired because the oracle stopped
   * updating it (an outage), which says nothing about the topic: its candidate goes back to the
   * queue, and the oracle lists it again as `<base>.<n>` if it still draws attention. A trend
   * retired sooner faded (it cooled below the attention floor and stayed there): its candidate
   * retires too.
   */
  async syncRetirements(): Promise<{ requeued: string[]; retired: string[] }> {
    const [trends, live] = await Promise.all([this.chain.trends(), this.store.candidates("live", 500)]);
    const out = { requeued: [] as string[], retired: [] as string[] };
    if (live.length === 0) return out;
    const staleWindow = await this.chain.staleRetireWindow();
    // A trend rotated out went stale on purpose: its topic made room, so it retires too.
    const rotated = this.cfg.rotation ? await this.store.rotatedIdentifiers() : new Set<string>();
    for (const c of live) {
      const listings = trends.filter((t) => baseOf(t.identifier) === c.identifier);
      if (listings.length === 0 || listings.some((t) => t.status !== "Retired")) continue;
      const last = listings.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.identifier > a.identifier) ? b : a));
      const stale = last.statusSince - last.updatedAt >= staleWindow && !rotated.has(last.identifier);
      if (!(await this.store.unlist(c.id, stale ? "approved" : "retired"))) continue;
      out[stale ? "requeued" : "retired"].push(c.identifier);
      this.log.info({ identifier: c.identifier, trend: last.identifier, stale }, stale ? "trend retired stale; candidate back in the queue" : "trend faded; candidate retired");
    }
    return out;
  }

  /**
   * One rotation step: finishes the running rotation once its trend retired, else starts one when
   * `pickRotation` finds a faded trend and a stronger candidate. The board never shrinks for a
   * rotation: if no new trend has taken the slot within `listGraceSec` (the oracle lists a
   * candidate only at its minimum index, and crypto only with smart-money inflow), the rotation is
   * called off while the oracle can still update the trend before the registry retires it, and the
   * next one waits `cooldownSec`. Returns what it did or is waiting on, for the report.
   */
  async rotate(nowSec = Math.floor(Date.now() / 1000)): Promise<string | null> {
    const rules = this.cfg.rotation;
    if (!rules) return null;
    const [active, trends] = await Promise.all([this.store.activeRotation(), this.chain.trends()]);
    if (active) {
      const t = trends.find((x) => x.identifier === active.identifier);
      if (!t || t.status === "Retired" || t.status === "None") {
        await this.store.finishRotation(active.id, "done");
        this.log.info({ identifier: active.identifier, replacement: active.replacement }, "rotation finished: trend retired");
        return `rotated out ${active.identifier}`;
      }
      const elapsed = nowSec - Math.floor(active.startedAt.getTime() / 1000);
      const holding = trends.filter((x) => (x.status === "Active" || x.status === "Cooling") && x.identifier !== active.identifier).length;
      if (holding < rules.maxLive && elapsed >= rules.listGraceSec && nowSec - t.updatedAt < rules.staleWindowSec - RESUME_MARGIN_SEC) {
        await this.store.finishRotation(active.id, "cancelled", "no new trend took its slot");
        this.log.warn({ identifier: active.identifier, holding }, "rotation called off: no new trend took its slot");
        return `rotation of ${active.identifier} called off: no new trend took its slot`;
      }
      if (elapsed > rules.timeoutSec) {
        await this.store.finishRotation(active.id, "cancelled", "timed out");
        this.log.warn({ identifier: active.identifier }, "rotation called off: the trend did not retire in time");
        return `rotation of ${active.identifier} timed out`;
      }
      return `rotating out ${active.identifier}`;
    }
    const live = trends.filter((t) => t.status === "Active" || t.status === "Cooling");
    if (live.length < rules.maxLive) return null;
    const [last] = await this.store.rotations(1);
    if (last?.status === "cancelled" && last.finishedAt && nowSec - Math.floor(last.finishedAt.getTime() / 1000) < rules.cooldownSec) return null;
    const [approved, pins] = await Promise.all([this.store.candidates("approved", 500), this.store.pins()]);
    if (approved.length === 0) return null;
    const latest = await this.store.latest([...new Set([...approved.map((c) => c.identifier), ...live.map((t) => baseOf(t.identifier))])]);
    const ready = rankQueue(approved, latest, { nowSec, confirmNetflowUsd: rules.confirmNetflowUsd, tradable: new Set(), pinned: pins });
    const pick = pickRotation(trends, ready, latest, pins, rules, nowSec);
    if (!pick) return null;
    const started = await this.store.startRotation({
      identifier: pick.trend.identifier,
      base: baseOf(pick.trend.identifier),
      trendId: pick.trend.id,
      replacement: pick.replacement.identifier,
      reason: pick.reason,
    });
    if (!started) return null;
    this.log.info({ identifier: pick.trend.identifier, replacement: pick.replacement.identifier, reason: pick.reason }, "rotation started");
    return `rotating out ${pick.trend.identifier} for ${pick.replacement.identifier}`;
  }

  async tick(nowMs = Date.now()): Promise<CollectorReport> {
    // Retirements first, so a topic back in the queue is tracked, and measured, from this tick on.
    const { requeued, retired } = await this.syncRetirements();
    const listed = await this.syncListings();
    const rotation = await this.rotate(Math.floor(nowMs / 1000)).catch((e: Error) => {
      this.log.warn({ error: e.message.slice(0, 200) }, "rotation step failed");
      return null;
    });
    const tracked = await this.tracked();
    const latest = await this.store.latest(tracked.map((t) => t.identifier));
    const report: CollectorReport = { tracked: tracked.length, measured: {}, failed: {}, elfaIntervalSec: 0, listed, requeued, retired, rotation, notes: [] };
    const now = new Date(nowMs);
    const age = (t: Tracked, s: SourceName) => {
      const r: Reading | undefined = latest.get(t.identifier)?.[s];
      const tried = s === "gdelt" ? (this.gdeltEmptyAt.get(t.identifier) ?? 0) : 0;
      const seen = Math.max(r?.observedAt ?? 0, tried);
      return seen > 0 ? nowMs / 1000 - seen : Number.POSITIVE_INFINITY;
    };
    const stalest = (s: SourceName, refreshSec: number, eligible: (t: Tracked) => boolean) =>
      tracked.filter((t) => eligible(t) && age(t, s) >= refreshSec).sort((a, b) => age(b, s) - age(a, s));
    const ok = (s: SourceName) => (report.measured[s] = (report.measured[s] ?? 0) + 1);
    const fail = (s: SourceName, t: Tracked | null, e: unknown) => {
      report.failed[s] = (report.failed[s] ?? 0) + 1;
      this.log.warn({ source: s, identifier: t?.identifier, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }, "measurement failed");
    };

    // Elfa: X and Telegram mentions over the last 24 hours.
    const elfaSection = async () => {
      const elfa = this.sources.elfa;
      if (!elfa || tracked.length === 0) return;
      if (elfa.ring.benched() >= elfa.ring.size) {
        report.notes.push("elfa: every key is sitting out (rejected, out of quota or proxy down)");
        return;
      }
      const radarCredits = typeof this.cfg.elfaRadarCreditsPerDay === "function" ? this.cfg.elfaRadarCreditsPerDay() : this.cfg.elfaRadarCreditsPerDay;
      const allowance = await elfa.ring.dailyAllowance();
      const forCollector = Math.max(1, allowance - radarCredits);
      // Live trends come first. When the budget cannot refresh every tracked trend well inside the
      // oracle's age limit, live trends get the refresh they need and candidates share what is
      // left: a live reading that kept expiring would switch the heaviest component on and off, and
      // the index would jump each time.
      const measurable = tracked.filter((x) => x.keywords.length > 0);
      const live = measurable.filter((x) => x.live);
      const waiting = measurable.filter((x) => !x.live);
      const intervalFor = (n: number, credits: number) => (credits > 0 ? Math.max(this.cfg.elfaRefreshSec, Math.ceil((n * 86_400) / credits)) : Number.POSITIVE_INFINITY);
      const usefulSec = ELFA_USEFUL_SHARE * (this.cfg.elfaMaxAgeSec ?? READING_MAX_AGE_SEC.elfa);
      let liveInterval = intervalFor(measurable.length, forCollector);
      let waitingInterval = liveInterval;
      if (liveInterval > usefulSec && live.length > 0) {
        liveInterval = intervalFor(live.length, forCollector);
        waitingInterval = intervalFor(waiting.length, forCollector - (live.length * 86_400) / liveInterval);
        report.notes.push(
          Number.isFinite(waitingInterval) ? `elfa: live trends first, candidates every ${waitingInterval}s` : `elfa: budget covers live trends only (${live.length} of ${measurable.length})`,
        );
      }
      report.elfaIntervalSec = liveInterval;
      const due = [...stalest("elfa", liveInterval, (x) => x.live && x.keywords.length > 0), ...stalest("elfa", waitingInterval, (x) => Number.isFinite(waitingInterval) && !x.live && x.keywords.length > 0)];
      const dayLeft = 1 - (nowMs % 86_400_000) / 86_400_000;
      const reserve = Math.ceil(radarCredits * dayLeft);
      for (const t of due) {
        if ((await elfa.ring.leftToday()) <= reserve) {
          report.notes.push("elfa: holding the rest of today's credits for the radar");
          break;
        }
        // Calls are spaced out: when the next one is not due, the rest wait for a later pass.
        const due = elfa.client.nextCallInMs();
        if (due > 0) {
          report.notes.push(`elfa: next call in ${Math.ceil(due / 1000)}s`);
          break;
        }
        const to = Math.floor(nowMs / 1000);
        try {
          const n = await elfa.client.mentions(t.keywords, to - MENTIONS_WINDOW_SEC, to);
          await this.store.addMeasurement(t.identifier, "elfa", "mentions", n, MENTIONS_WINDOW_SEC, now);
          ok("elfa");
        } catch (e) {
          if (e instanceof PacedError) {
            report.notes.push(`elfa: next call in ${Math.ceil(e.waitMs / 1000)}s`);
            break;
          }
          fail("elfa", t, e);
          if (e instanceof BudgetError) break;
        }
      }
    };

    // Wikipedia: views of the trend's article on the latest published day.
    const wikipediaSection = async () => {
      for (const t of stalest("wikipedia", this.cfg.wikipediaRefreshSec, (x) => x.article !== null).slice(0, this.cfg.maxWikipediaPerTick)) {
        try {
          const views = await this.sources.wikipedia.latestPageviews(t.article!, nowMs);
          await this.store.addMeasurement(t.identifier, "wikipedia", "pageviews", views, 86_400, now);
          ok("wikipedia");
        } catch (e) {
          fail("wikipedia", t, e);
        }
      }
    };

    // GDELT: news articles over the last day, a few per tick.
    const gdeltSection = async () => {
      if (!this.sources.gdelt.available) {
        report.notes.push("gdelt: resting after rate limiting");
        return;
      }
      const searchable = (x: Tracked) => x.keywords.some((k) => !k.startsWith("$"));
      const due = [
        ...stalest("gdelt", this.cfg.gdeltRefreshSec, (x) => x.live && searchable(x)),
        ...stalest("gdelt", this.cfg.gdeltCandidateRefreshSec ?? this.cfg.gdeltRefreshSec, (x) => !x.live && searchable(x)),
      ].slice(0, this.cfg.maxGdeltPerTick);
      const deadline = Date.now() + (this.cfg.gdeltTickBudgetMs ?? DEFAULT_GDELT_TICK_BUDGET_MS);
      for (const t of due) {
        if (Date.now() > deadline) break;
        try {
          const n = await this.sources.gdelt.articles(t.keywords);
          if (n === null) {
            this.gdeltEmptyAt.set(t.identifier, nowMs / 1000);
            report.notes.push(`gdelt: no timeline for ${t.identifier}`);
            continue;
          }
          await this.store.addMeasurement(t.identifier, "gdelt", "articles", n, 86_400, now);
          ok("gdelt");
        } catch (e) {
          fail("gdelt", t, e);
          if (!this.sources.gdelt.available) break;
        }
      }
    };

    // Nansen: one call for every crypto ticker when any reading is due.
    const nansenSection = async () => {
      const crypto = tracked.filter((t) => t.ticker !== null && (t.assetClass === CRYPTO || assetClassOf(t.identifier) === CRYPTO));
      if (!this.sources.nansen || crypto.length === 0 || !crypto.some((t) => age(t, "nansen") >= this.cfg.nansenRefreshSec)) return;
      try {
        const flows = await this.sources.nansen.netflow();
        for (const t of crypto) {
          // A ticker smart money did not trade has no flow: zero, not unknown.
          await this.store.addMeasurement(t.identifier, "nansen", "netflow_usd", flows.get(t.ticker!) ?? 0, 86_400, now);
          ok("nansen");
        }
      } catch (e) {
        fail("nansen", null, e);
      }
    };

    // Bluesky: posts matching the keywords over the last 24 hours, one search per trend.
    const blueskySection = async () => {
      const bluesky = this.sources.bluesky;
      if (!bluesky) return;
      if (!bluesky.available) {
        report.notes.push("bluesky: resting after rate limiting");
        return;
      }
      const due = stalest("bluesky", this.cfg.blueskyRefreshSec ?? DEFAULT_BLUESKY_REFRESH_SEC, (x) => blueskyQuery(x.keywords) !== null);
      for (const t of due.slice(0, this.cfg.maxBlueskyPerTick ?? 10)) {
        const to = Math.floor(nowMs / 1000);
        try {
          const n = await bluesky.mentions(t.keywords, to - MENTIONS_WINDOW_SEC, to);
          await this.store.addMeasurement(t.identifier, "bluesky", "posts", n, MENTIONS_WINDOW_SEC, now);
          ok("bluesky");
        } catch (e) {
          fail("bluesky", t, e);
          if (!bluesky.available) break;
        }
      }
    };

    // Hacker News: stories and comments mentioning the keywords over the last 24 hours.
    const hnSection = async () => {
      const hn = this.sources.hn;
      if (!hn) return;
      if (!hn.available) {
        report.notes.push("hn: resting after rate limiting");
        return;
      }
      const due = stalest("hn", this.cfg.hnRefreshSec ?? DEFAULT_HN_REFRESH_SEC, (x) => hnTerms(x.keywords).length > 0);
      for (const t of due.slice(0, this.cfg.maxHnPerTick ?? 10)) {
        try {
          const n = await hn.mentions(t.keywords, Math.floor(nowMs / 1000) - MENTIONS_WINDOW_SEC);
          await this.store.addMeasurement(t.identifier, "hn", "mentions", n, MENTIONS_WINDOW_SEC, now);
          ok("hn");
        } catch (e) {
          fail("hn", t, e);
          if (!hn.available) break;
        }
      }
    };

    await Promise.all([elfaSection(), wikipediaSection(), gdeltSection(), nansenSection(), blueskySection(), hnSection()]);
    return report;
  }
}
