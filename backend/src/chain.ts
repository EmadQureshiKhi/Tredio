import { Viewer } from "@tredio/chain";
import type { Checkpoint, Deployment, RegistryParams, Trend } from "@tredio/contracts";

/**
 * Read-only NEAR access: the registry's trends, read through RPC with provider failover and
 * cached briefly, since the radar, collector and API all ask for them.
 */

export const STATUS = ["None", "Active", "Cooling", "Retired"] as const;
const FROM_CHAIN: Record<Trend["status"], ChainTrend["status"]> = { active: "Active", cooling: "Cooling", retired: "Retired" };
const ASSET_CLASSES = ["crypto", "equity", "commodity", "fx", "person", "politics", "topic"] as const;

export interface ChainTrend {
  /** The trend's identifier (`topic:openai`), which is its id on NEAR. */
  id: string;
  identifier: string;
  assetClass: number;
  status: (typeof STATUS)[number];
  createdAt: number;
  updatedAt: number;
  /** When the trend entered its current status (for a retired trend, when it retired). */
  statusSince: number;
  /** Index points (registry units / 1e6). */
  index: number;
  peakIndex: number;
  surfacer: string;
  reviewHash: string | null;
  asset: string | null;
}

const PAGE = 100;
const INDEX_SCALE = 1_000_000;

export class ChainReader {
  readonly viewer: Viewer;
  private cache: { at: number; trends: ChainTrend[]; lastRunId: bigint } | null = null;
  private params: Promise<RegistryParams> | null = null;
  private inflight: Promise<{ trends: ChainTrend[]; lastRunId: bigint }> | null = null;

  constructor(
    rpcUrls: readonly string[],
    readonly deployment: Deployment,
    private readonly ttlMs = 15_000,
  ) {
    this.viewer = new Viewer(deployment.network, [...rpcUrls]);
  }

  get registry(): string {
    return this.deployment.contracts.registry;
  }

  /** Every trend the registry knows, retired ones included, in creation order. */
  async trends(): Promise<ChainTrend[]> {
    return (await this.snapshot()).trends;
  }

  /** The newest oracle run the registry accepted. */
  async lastRunId(): Promise<bigint> {
    return (await this.snapshot()).lastRunId;
  }

  /** The registry's parameters (fixed at deploy, read once). */
  async registryParams(): Promise<RegistryParams> {
    this.params ??= this.viewer.view<RegistryParams>(this.registry, "get_params").catch((e: unknown) => {
      this.params = null;
      throw e;
    });
    return this.params;
  }

  /**
   * Seconds without an update after which anyone may retire a trend. A trend retired that late
   * was retired because the oracle stopped updating it, not because its topic faded.
   */
  async staleRetireWindow(): Promise<number> {
    return (await this.registryParams()).stale_retire_window;
  }

  /** Status codes (index into STATUS) for `ids`, from the cached snapshot. */
  async statuses(ids: readonly string[]): Promise<number[]> {
    const byId = new Map((await this.trends()).map((t) => [t.id, STATUS.indexOf(t.status)]));
    return ids.map((id) => byId.get(id) ?? 0);
  }

  /** Recent on-chain checkpoints of a trend (the registry keeps the last 96). */
  async checkpoints(id: string): Promise<Checkpoint[]> {
    return this.viewer.view<Checkpoint[]>(this.registry, "history", { id });
  }

  private async snapshot(): Promise<{ trends: ChainTrend[]; lastRunId: bigint }> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache;
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<{ trends: ChainTrend[]; lastRunId: bigint }> {
    const [count, lastRunId] = await Promise.all([
      this.viewer.view<number>(this.registry, "trend_count"),
      this.viewer.view<number>(this.registry, "last_run_id"),
    ]);
    const trends: ChainTrend[] = [];
    for (let from = 0; from < count; from += PAGE) {
      const page = await this.viewer.view<Trend[]>(this.registry, "get_trends", { from_index: from, limit: PAGE });
      for (const t of page) {
        trends.push({
          id: t.id,
          identifier: t.id,
          assetClass: ASSET_CLASSES.indexOf(t.asset_class),
          status: FROM_CHAIN[t.status] ?? "None",
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          statusSince: t.status_since,
          index: t.index / INDEX_SCALE,
          peakIndex: t.peak_index / INDEX_SCALE,
          surfacer: t.surfacer ?? "",
          reviewHash: t.review_hash,
          asset: t.asset,
        });
      }
    }
    const snap = { trends, lastRunId: BigInt(lastRunId) };
    this.cache = { ...snap, at: Date.now() };
    return snap;
  }
}
