import { checkReviewBodies, reviewHash, type ReviewEvidence, type SignedReview } from "./ai/evidence";
import type { Sql } from "./db";
import { assetClassOf } from "./identifiers";

/** Typed queries over the radar, collector and app tables. */

/** The surfacer recorded for candidates the radar proposed itself. */
export const RADAR_SURFACER = "radar";

/** `retired`: its trend faded (retired after cooling), so it leaves the queue for good. */
export type CandidateStatus = "pending" | "approved" | "rejected" | "live" | "retired";
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
export type SourceName = "elfa" | "gdelt" | "nansen" | "wikipedia" | "bluesky" | "hn";
export const SOURCES: readonly SourceName[] = ["elfa", "gdelt", "nansen", "wikipedia", "bluesky", "hn"];

export interface Candidate {
  id: number;
  identifier: string;
  displayName: string;
  assetClass: number;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  summary: string | null;
  source: CandidateSource;
  sourceRef: Record<string, unknown>;
  surfacer: string;
  status: CandidateStatus;
  confidence: number;
  ai: Record<string, unknown>;
  decidedBy: string | null;
  /** SHA-256 of the AI review evidence (ai_reviews), when a verifiable model reviewed it. */
  reviewHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCandidate {
  identifier: string;
  displayName: string;
  assetClass: number;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  summary: string | null;
  source: CandidateSource;
  sourceRef: Record<string, unknown>;
  surfacer: string;
  status: CandidateStatus;
  confidence: number;
  ai: Record<string, unknown>;
  decidedBy: string | null;
  /** SHA-256 of the verified NEAR AI Cloud review that assessed it (ai_reviews). */
  reviewHash?: string | null;
}

/** A verified NEAR AI Cloud review as stored (ai_reviews), keyed by its review hash. */
export interface StoredReview {
  hash: string;
  evidence: ReviewEvidence;
  /** The exact request JSON and response body the signature covers; null if stored before they were kept. */
  request: string | null;
  response: string | null;
  createdAt: Date;
}

export interface TrendMeta {
  identifier: string;
  trendId: string;
  displayName: string;
  summary: string | null;
  keywords: string[];
  article: string | null;
  ticker: string | null;
}

export interface Reading {
  value: number;
  windowSec: number;
  observedAt: number;
}

interface CandidateRow {
  id: string;
  identifier: string;
  display_name: string;
  asset_class: number;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  summary: string | null;
  source: CandidateSource;
  source_ref: Record<string, unknown>;
  surfacer: string;
  status: CandidateStatus;
  confidence: number;
  ai: Record<string, unknown>;
  decided_by: string | null;
  created_at: Date;
  updated_at: Date;
  review_hash: string | null;
}

const toCandidate = (r: CandidateRow): Candidate => ({
  id: Number(r.id),
  identifier: r.identifier,
  displayName: r.display_name,
  assetClass: r.asset_class,
  keywords: r.keywords,
  article: r.article,
  ticker: r.ticker,
  summary: r.summary,
  source: r.source,
  sourceRef: r.source_ref,
  surfacer: r.surfacer,
  status: r.status,
  confidence: r.confidence,
  ai: r.ai,
  decidedBy: r.decided_by,
  reviewHash: r.review_hash ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface Rotation {
  id: number;
  identifier: string;
  base: string;
  trendId: string;
  replacement: string | null;
  reason: string;
  status: "rotating" | "done" | "cancelled";
  startedAt: Date;
  finishedAt: Date | null;
}

interface RotationRow {
  id: string;
  identifier: string;
  base: string;
  trend_id: string;
  replacement: string | null;
  reason: string;
  status: Rotation["status"];
  started_at: Date;
  finished_at: Date | null;
}

const toRotation = (r: RotationRow): Rotation => ({
  id: Number(r.id),
  identifier: r.identifier,
  base: r.base,
  trendId: r.trend_id,
  replacement: r.replacement,
  reason: r.reason,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export class Store {
  constructor(readonly sql: Sql) {}

  /** Inserts a candidate unless its identifier exists; returns the row either way and whether it is new. */
  async insertCandidate(c: NewCandidate): Promise<{ candidate: Candidate; created: boolean }> {
    const sql = this.sql;
    const inserted = await sql<CandidateRow[]>`
      INSERT INTO candidates (identifier, display_name, asset_class, keywords, article, ticker, summary, source, source_ref, surfacer, status, confidence, ai, decided_by, review_hash)
      VALUES (${c.identifier}, ${c.displayName}, ${c.assetClass}, ${sql.array(c.keywords)}, ${c.article}, ${c.ticker}, ${c.summary},
              ${c.source}, ${sql.json(c.sourceRef as never)}, ${c.surfacer.toLowerCase()}, ${c.status}, ${c.confidence}, ${sql.json(c.ai as never)}, ${c.decidedBy}, ${c.reviewHash ?? null})
      ON CONFLICT (identifier) DO NOTHING
      RETURNING *`;
    if (inserted[0]) return { candidate: toCandidate(inserted[0]), created: true };
    const existing = await this.candidateByIdentifier(c.identifier);
    if (!existing) throw new Error(`candidate ${c.identifier} vanished`);
    return { candidate: existing, created: false };
  }

  /**
   * Stores a verified review under its hash (idempotent) and returns the hash: the evidence and the
   * exact request and response bodies its signature covers, which must hash to its signed text.
   */
  async saveReview(r: SignedReview): Promise<string> {
    if (!checkReviewBodies(r.evidence, r).ok) throw new Error("review bodies do not hash to the signed text");
    const hash = reviewHash(r.evidence);
    await this.sql`
      INSERT INTO ai_reviews (review_hash, model, completion_id, evidence, request_body, response_body)
      VALUES (${hash}, ${r.evidence.model}, ${r.evidence.completionId}, ${this.sql.json(r.evidence as never)}, ${r.request}, ${r.response})
      ON CONFLICT (review_hash) DO NOTHING`;
    return hash;
  }

  /** A stored review; `request` and `response` are null for one stored before the bodies were kept. */
  async review(hash: string): Promise<StoredReview | null> {
    const rows = await this.sql<{ review_hash: string; evidence: ReviewEvidence; request_body: string | null; response_body: string | null; created_at: Date }[]>`
      SELECT review_hash, evidence, request_body, response_body, created_at FROM ai_reviews WHERE review_hash = ${hash}`;
    const row = rows[0];
    return row ? { hash: row.review_hash, evidence: row.evidence, request: row.request_body, response: row.response_body, createdAt: row.created_at } : null;
  }

  async candidateByIdentifier(identifier: string): Promise<Candidate | null> {
    const rows = await this.sql<CandidateRow[]>`SELECT * FROM candidates WHERE identifier = ${identifier}`;
    return rows[0] ? toCandidate(rows[0]) : null;
  }

  async candidate(id: number): Promise<Candidate | null> {
    const rows = await this.sql<CandidateRow[]>`SELECT * FROM candidates WHERE id = ${id}`;
    return rows[0] ? toCandidate(rows[0]) : null;
  }

  async candidates(status: CandidateStatus | null, limit = 200): Promise<Candidate[]> {
    const rows = status
      ? await this.sql<CandidateRow[]>`SELECT * FROM candidates WHERE status = ${status} ORDER BY updated_at DESC LIMIT ${limit}`
      : await this.sql<CandidateRow[]>`SELECT * FROM candidates ORDER BY updated_at DESC LIMIT ${limit}`;
    return rows.map(toCandidate);
  }

  /** Every identifier the radar knows, newest first, for duplicate checks. */
  async knownIdentifiers(limit = 300): Promise<string[]> {
    const rows = await this.sql<{ identifier: string }[]>`
      SELECT identifier FROM (
        SELECT identifier, updated_at FROM candidates WHERE status <> 'rejected'
        UNION ALL SELECT identifier, updated_at FROM trend_meta
      ) x GROUP BY identifier ORDER BY max(updated_at) DESC LIMIT ${limit}`;
    return rows.map((r) => r.identifier);
  }

  async decide(
    id: number,
    status: "approved" | "rejected",
    by: string,
    edits: Partial<Pick<Candidate, "identifier" | "displayName" | "keywords" | "article" | "summary">> = {},
  ): Promise<Candidate | null> {
    const sql = this.sql;
    const rows = await sql<CandidateRow[]>`
      UPDATE candidates SET
        status = ${status},
        decided_by = ${by.toLowerCase()},
        identifier = COALESCE(${edits.identifier ?? null}, identifier),
        asset_class = COALESCE(${edits.identifier ? assetClassOf(edits.identifier) : null}, asset_class),
        display_name = COALESCE(${edits.displayName ?? null}, display_name),
        keywords = COALESCE(${edits.keywords ? sql.array(edits.keywords) : null}, keywords),
        article = CASE WHEN ${edits.article !== undefined} THEN ${edits.article ?? null} ELSE article END,
        summary = COALESCE(${edits.summary ?? null}, summary),
        updated_at = now()
      WHERE id = ${id} AND status IN ('pending', 'approved', 'rejected', 'retired')
      RETURNING *`;
    return rows[0] ? toCandidate(rows[0]) : null;
  }

  /** Marks a candidate live once its trend is listed, and records the trend's metadata. */
  async markLive(candidate: Candidate, listedIdentifier: string, trendId: string): Promise<void> {
    const sql = this.sql;
    await sql.begin(async (tx) => {
      await tx`UPDATE candidates SET status = 'live', updated_at = now() WHERE id = ${candidate.id}`;
      await tx`
        INSERT INTO trend_meta (identifier, trend_id, display_name, summary, keywords, article, ticker)
        VALUES (${listedIdentifier}, ${trendId}, ${candidate.displayName}, ${candidate.summary}, ${sql.array(candidate.keywords)}, ${candidate.article}, ${candidate.ticker})
        ON CONFLICT (identifier) DO NOTHING`;
    });
  }

  /**
   * Moves a live candidate on once every listing of its topic has retired: back to `approved`, so
   * the oracle lists it again under its next identifier, or to `retired`. Only from `live`, so a
   * decision made since stands.
   */
  async unlist(id: number, to: "approved" | "retired"): Promise<boolean> {
    const rows = await this.sql`UPDATE candidates SET status = ${to}, updated_at = now() WHERE id = ${id} AND status = 'live' RETURNING id`;
    return rows.length > 0;
  }

  /** The rotation in progress, if any (at most one). */
  async activeRotation(): Promise<Rotation | null> {
    const rows = await this.sql<RotationRow[]>`SELECT * FROM rotations WHERE status = 'rotating' LIMIT 1`;
    return rows[0] ? toRotation(rows[0]) : null;
  }

  /** Starts a rotation; null when one is already running (the unique index holds one at a time). */
  async startRotation(r: { identifier: string; base: string; trendId: string; replacement: string | null; reason: string }): Promise<Rotation | null> {
    const rows = await this.sql<RotationRow[]>`
      INSERT INTO rotations (identifier, base, trend_id, replacement, reason)
      VALUES (${r.identifier}, ${r.base}, ${r.trendId}, ${r.replacement}, ${r.reason})
      ON CONFLICT DO NOTHING RETURNING *`;
    return rows[0] ? toRotation(rows[0]) : null;
  }

  async finishRotation(id: number, status: "done" | "cancelled", note?: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE rotations SET status = ${status}, finished_at = now(),
        reason = CASE WHEN ${note ?? null}::text IS NULL THEN reason ELSE reason || ' (' || ${note ?? ""} || ')' END
       WHERE id = ${id} AND status = 'rotating' RETURNING id`;
    return rows.length > 0;
  }

  async rotations(limit = 20): Promise<Rotation[]> {
    const rows = await this.sql<RotationRow[]>`SELECT * FROM rotations ORDER BY started_at DESC LIMIT ${limit}`;
    return rows.map(toRotation);
  }

  /** Listed identifiers that rotated out or are rotating out (their topics retire, never requeue). */
  async rotatedIdentifiers(): Promise<Set<string>> {
    const rows = await this.sql<{ identifier: string }[]>`SELECT identifier FROM rotations WHERE status IN ('rotating', 'done')`;
    return new Set(rows.map((r) => r.identifier));
  }

  /** Base identifiers an admin keeps live. */
  async pins(): Promise<Set<string>> {
    const rows = await this.sql<{ identifier: string }[]>`SELECT identifier FROM trend_pins`;
    return new Set(rows.map((r) => r.identifier));
  }

  async setPin(base: string, pinned: boolean, by: string): Promise<void> {
    if (pinned) await this.sql`INSERT INTO trend_pins (identifier, pinned_by) VALUES (${base}, ${by.toLowerCase()}) ON CONFLICT (identifier) DO NOTHING`;
    else await this.sql`DELETE FROM trend_pins WHERE identifier = ${base}`;
  }

  /** "Notify me when it lists": only approved candidates can be watched. */
  async watch(candidateId: number, account: string): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO candidate_watches (candidate_id, account)
      SELECT id, ${account.toLowerCase()} FROM candidates WHERE id = ${candidateId} AND status = 'approved'
      ON CONFLICT DO NOTHING RETURNING candidate_id`;
    return rows.length > 0 || (await this.watching(account)).has(candidateId);
  }

  async unwatch(candidateId: number, account: string): Promise<void> {
    await this.sql`DELETE FROM candidate_watches WHERE candidate_id = ${candidateId} AND account = ${account.toLowerCase()} AND notified_at IS NULL`;
  }

  /** The candidates an account is waiting on (not yet notified). */
  async watching(account: string): Promise<Set<number>> {
    const rows = await this.sql<{ candidate_id: string }[]>`
      SELECT candidate_id FROM candidate_watches WHERE account = ${account.toLowerCase()} AND notified_at IS NULL`;
    return new Set(rows.map((r) => Number(r.candidate_id)));
  }

  /** How many accounts wait on each candidate. */
  async watchCounts(ids: readonly number[]): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.sql<{ candidate_id: string; n: number }[]>`
      SELECT candidate_id, count(*)::int AS n FROM candidate_watches
       WHERE candidate_id = ANY(${this.sql.array(ids.map(String))}::bigint[]) AND notified_at IS NULL GROUP BY candidate_id`;
    return new Map(rows.map((r) => [Number(r.candidate_id), r.n]));
  }

  /** Readings since `sinceSec` for many identifiers at once, oldest first (radar sparklines). */
  async historyMany(identifiers: readonly string[], sources: readonly SourceName[], sinceSec: number): Promise<Map<string, Array<{ source: SourceName; value: number; observedAt: number }>>> {
    const out = new Map<string, Array<{ source: SourceName; value: number; observedAt: number }>>();
    if (identifiers.length === 0) return out;
    const rows = await this.sql<{ identifier: string; source: SourceName; value: number; observed_at: Date }[]>`
      SELECT identifier, source, value, observed_at FROM measurements
       WHERE identifier = ANY(${this.sql.array([...identifiers])}) AND source = ANY(${this.sql.array([...sources])})
         AND observed_at >= to_timestamp(${sinceSec})
       ORDER BY observed_at`;
    for (const r of rows) {
      const list = out.get(r.identifier) ?? [];
      list.push({ source: r.source, value: r.value, observedAt: Math.floor(r.observed_at.getTime() / 1000) });
      out.set(r.identifier, list);
    }
    return out;
  }

  async upsertTrendMeta(m: TrendMeta): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO trend_meta (identifier, trend_id, display_name, summary, keywords, article, ticker)
      VALUES (${m.identifier}, ${m.trendId}, ${m.displayName}, ${m.summary}, ${sql.array(m.keywords)}, ${m.article}, ${m.ticker})
      ON CONFLICT (identifier) DO UPDATE SET display_name = EXCLUDED.display_name, summary = EXCLUDED.summary,
        keywords = EXCLUDED.keywords, article = EXCLUDED.article, ticker = EXCLUDED.ticker, updated_at = now()`;
  }

  async trendMeta(): Promise<Map<string, TrendMeta>> {
    const rows = await this.sql<
      { identifier: string; trend_id: string; display_name: string; summary: string | null; keywords: string[]; article: string | null; ticker: string | null }[]
    >`SELECT identifier, trend_id, display_name, summary, keywords, article, ticker FROM trend_meta`;
    return new Map(
      rows.map((r) => [
        r.identifier,
        { identifier: r.identifier, trendId: r.trend_id, displayName: r.display_name, summary: r.summary, keywords: r.keywords, article: r.article, ticker: r.ticker },
      ]),
    );
  }

  async addMeasurement(identifier: string, source: SourceName, metric: string, value: number, windowSec: number, observedAt: Date): Promise<void> {
    await this.sql`
      INSERT INTO measurements (identifier, source, metric, value, window_sec, observed_at)
      VALUES (${identifier}, ${source}, ${metric}, ${value}, ${windowSec}, ${observedAt})`;
  }

  /** The latest reading of every source for each identifier. */
  async latest(identifiers: readonly string[]): Promise<Map<string, Partial<Record<SourceName, Reading>>>> {
    const out = new Map<string, Partial<Record<SourceName, Reading>>>();
    if (identifiers.length === 0) return out;
    const rows = await this.sql<{ identifier: string; source: SourceName; value: number; window_sec: number; observed_at: Date }[]>`
      SELECT DISTINCT ON (identifier, source) identifier, source, value, window_sec, observed_at
        FROM measurements
       WHERE identifier = ANY(${this.sql.array([...identifiers])})
       ORDER BY identifier, source, observed_at DESC`;
    for (const r of rows) {
      const entry = out.get(r.identifier) ?? {};
      entry[r.source] = { value: r.value, windowSec: r.window_sec, observedAt: Math.floor(r.observed_at.getTime() / 1000) };
      out.set(r.identifier, entry);
    }
    return out;
  }

  /** Each source's newest reading and how many readings it took in the last hour, for health. */
  async readingFreshness(nowSec: number): Promise<Array<{ source: SourceName; newestAt: number | null; lastHour: number }>> {
    return Promise.all(
      SOURCES.map(async (source) => {
        const [r] = await this.sql<{ newest: Date | null; hour: number }[]>`
          SELECT (SELECT max(observed_at) FROM measurements WHERE source = ${source}) AS newest,
                 (SELECT count(*)::int FROM measurements WHERE source = ${source} AND observed_at >= to_timestamp(${nowSec - 3600})) AS hour`;
        return { source, newestAt: r?.newest ? r.newest.getTime() : null, lastHour: r?.hour ?? 0 };
      }),
    );
  }

  /** Throws when the database does not answer. */
  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async history(identifier: string, sinceSec: number): Promise<Array<{ source: SourceName; value: number; observedAt: number }>> {
    const rows = await this.sql<{ source: SourceName; value: number; observed_at: Date }[]>`
      SELECT source, value, observed_at FROM measurements
       WHERE identifier = ${identifier} AND observed_at >= to_timestamp(${sinceSec})
       ORDER BY observed_at`;
    return rows.map((r) => ({ source: r.source, value: r.value, observedAt: Math.floor(r.observed_at.getTime() / 1000) }));
  }

  /** Signal keys assessed within `freshSec`, so the radar skips them. */
  async assessedSignals(keys: readonly string[], freshSec: number): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.sql<{ key: string }[]>`
      SELECT key FROM radar_signals WHERE key = ANY(${this.sql.array([...keys])}) AND assessed_at > now() - make_interval(secs => ${freshSec})`;
    return new Set(rows.map((r) => r.key));
  }

  async recordSignal(key: string, kind: string, identifier: string | null): Promise<void> {
    await this.sql`
      INSERT INTO radar_signals (key, kind, identifier) VALUES (${key}, ${kind}, ${identifier})
      ON CONFLICT (key) DO UPDATE SET identifier = EXCLUDED.identifier, assessed_at = now()`;
  }

  async addLinkRequest(url: string, submitter: string): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`INSERT INTO link_requests (url, submitter) VALUES (${url}, ${submitter.toLowerCase()}) RETURNING id`;
    return Number(rows[0]!.id);
  }

  async finishLinkRequest(id: number, status: "proposed" | "rejected" | "failed", candidateId: number | null, reason: string | null): Promise<void> {
    await this.sql`UPDATE link_requests SET status = ${status}, candidate_id = ${candidateId}, reason = ${reason} WHERE id = ${id}`;
  }

  async recentLinkRequests(submitter: string, sinceSec: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM link_requests WHERE submitter = ${submitter.toLowerCase()} AND created_at > now() - make_interval(secs => ${sinceSec})`;
    return rows[0]?.n ?? 0;
  }

  async isRevoked(tokenHash: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM revoked_tokens WHERE token_hash = ${tokenHash}`;
    return rows.length > 0;
  }

  async revoke(tokenHash: string, expiresAt: number): Promise<void> {
    await this.sql`INSERT INTO revoked_tokens (token_hash, expires_at) VALUES (${tokenHash}, ${expiresAt}) ON CONFLICT DO NOTHING`;
  }

  async jobOk(job: string, report: Record<string, unknown>): Promise<void> {
    await this.sql`
      INSERT INTO job_runs (job, last_ok_at, last_report) VALUES (${job}, now(), ${this.sql.json(report as never)})
      ON CONFLICT (job) DO UPDATE SET last_ok_at = now(), last_report = EXCLUDED.last_report`;
  }

  async jobFailed(job: string, error: string): Promise<void> {
    await this.sql`
      INSERT INTO job_runs (job, last_error, last_error_at) VALUES (${job}, ${error.slice(0, 500)}, now())
      ON CONFLICT (job) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now()`;
  }

  async jobs(): Promise<Array<{ job: string; lastOkAt: Date | null; lastError: string | null; lastErrorAt: Date | null; lastReport: Record<string, unknown> }>> {
    const rows = await this.sql<{ job: string; last_ok_at: Date | null; last_error: string | null; last_error_at: Date | null; last_report: Record<string, unknown> }[]>`
      SELECT * FROM job_runs ORDER BY job`;
    return rows.map((r) => ({ job: r.job, lastOkAt: r.last_ok_at, lastError: r.last_error, lastErrorAt: r.last_error_at, lastReport: r.last_report }));
  }
}
