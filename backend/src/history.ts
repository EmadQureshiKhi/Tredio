import type { ChainReader, ChainTrend } from "./chain";
import type { Sql } from "./db";

/**
 * Attention index history. The registry keeps each trend's last 96 checkpoints on chain; this
 * mirrors new ones into Postgres every few minutes, so charts and backtests read a trend's whole
 * history without walking the chain each time.
 */

export interface IndexPoint {
  /** Unix seconds. */
  t: number;
  /** Index points (0 to 100). */
  v: number;
}

const INDEX_SCALE = 1_000_000;

export class IndexHistory {
  constructor(
    private readonly sql: Sql,
    private readonly chain: ChainReader,
  ) {}

  /** Copies new checkpoints of every trend; a trend that has not changed since the last copy costs no read. */
  async sync(): Promise<{ trends: number; added: number }> {
    const trends = await this.chain.trends();
    const synced = new Map((await this.sql<{ trend_id: string; synced: string }[]>`SELECT trend_id, synced FROM index_sync`).map((r) => [r.trend_id, Number(r.synced)]));
    let added = 0;
    for (const t of trends) {
      const last = synced.get(t.id) ?? 0;
      if (t.updatedAt > last) added += await this.syncTrend(t, last);
    }
    return { trends: trends.length, added };
  }

  private async syncTrend(t: ChainTrend, after: number): Promise<number> {
    const rows = (await this.chain.checkpoints(t.id)).filter((c) => c.at > after).map((c) => ({ trend_id: t.id, observed_at: c.at, points: c.index / INDEX_SCALE }));
    if (rows.length === 0) return 0;
    const newest = Math.max(...rows.map((r) => r.observed_at));
    await this.sql.begin(async (tx) => {
      await tx`INSERT INTO index_points ${tx(rows, "trend_id", "observed_at", "points")} ON CONFLICT DO NOTHING`;
      await tx`
        INSERT INTO index_sync (trend_id, identifier, synced) VALUES (${t.id}, ${t.identifier}, ${newest})
        ON CONFLICT (trend_id) DO UPDATE SET synced = GREATEST(index_sync.synced, EXCLUDED.synced), updated_at = now()`;
    });
    return rows.length;
  }

  /**
   * For each trend: up to `buckets` evenly spaced values over the last `windowSec` (the last
   * observation in each bucket, carried forward) and the change since the window opened, in percent.
   */
  async summaries(trendIds: readonly string[], nowSec: number, windowSec = 86_400, buckets = 24): Promise<Map<string, { spark: number[]; change: number | null }>> {
    const out = new Map<string, { spark: number[]; change: number | null }>();
    if (trendIds.length === 0) return out;
    const from = nowSec - windowSec;
    const rows = await this.sql<{ trend_id: string; observed_at: string; points: number }[]>`
      SELECT trend_id, observed_at, points FROM index_points WHERE trend_id = ANY(${this.sql.array([...trendIds])}) AND observed_at >= ${from - 7_200} ORDER BY trend_id, observed_at`;
    const by = new Map<string, Array<{ t: number; v: number }>>();
    for (const r of rows) by.set(r.trend_id, [...(by.get(r.trend_id) ?? []), { t: Number(r.observed_at), v: r.points }]);
    for (const id of trendIds) {
      const pts = by.get(id) ?? [];
      const spark: number[] = [];
      let i = 0;
      let last: number | null = null;
      for (let b = 1; b <= buckets; b++) {
        const end = from + (windowSec * b) / buckets;
        while (i < pts.length && pts[i]!.t <= end) last = pts[i++]!.v;
        if (last !== null) spark.push(last);
      }
      const opening = [...pts].reverse().find((p) => p.t <= from)?.v ?? pts[0]?.v ?? null;
      const latest = pts.at(-1)?.v ?? null;
      out.set(id, { spark, change: opening && latest !== null ? ((latest - opening) / opening) * 100 : null });
    }
    return out;
  }

  /** A trend's points since `sinceSec` (all when 0), oldest first. */
  async points(trendId: string, sinceSec = 0, untilSec = Number.MAX_SAFE_INTEGER): Promise<IndexPoint[]> {
    const rows = await this.sql<{ observed_at: string; points: number }[]>`
      SELECT observed_at, points FROM index_points
       WHERE trend_id = ${trendId} AND observed_at >= ${sinceSec} AND observed_at <= ${untilSec}
       ORDER BY observed_at`;
    return rows.map((r) => ({ t: Number(r.observed_at), v: r.points }));
  }
}
