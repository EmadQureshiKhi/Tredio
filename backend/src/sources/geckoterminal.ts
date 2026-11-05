import { query } from "./http";
import { Polite, type PoliteOptions, TtlCache } from "./polite";

/**
 * GeckoTerminal's trending DEX pools across networks (https://www.geckoterminal.com/dex-api),
 * keyless, about 30 calls a minute. Most trending pools are fresh memecoins, so the radar keeps
 * only pools with real volume and liquidity and lets the AI review judge the rest. The list is
 * fetched at most once every ten minutes. GeckoTerminal is CoinGecko's, and the same attribution
 * applies.
 */

export const GECKOTERMINAL_API = "https://api.geckoterminal.com/api/v2";
const TTL_MS = 10 * 60_000;

export interface TrendingPool {
  /** The pool's base token. */
  symbol: string;
  tokenName: string;
  network: string;
  poolName: string;
  volume24hUsd: number;
  reserveUsd: number;
  priceChange24hPercent: number | null;
  /** GeckoTerminal's link to the pool. */
  url: string | null;
}

export class GeckoTerminal {
  readonly http: Polite;
  private readonly cache: TtlCache<TrendingPool[]>;

  constructor(
    private readonly baseUrl = GECKOTERMINAL_API,
    opts: Partial<PoliteOptions> = {},
  ) {
    this.http = new Polite("geckoterminal", { spacingMs: 3_000, ...opts });
    this.cache = new TtlCache(TTL_MS, opts.now);
  }

  /** Trending pools over 24 hours, every network, base token included. */
  trendingPools(): Promise<TrendingPool[]> {
    return this.cache.get(async () =>
      parseTrendingPools(await this.http.json(`${this.baseUrl}/networks/trending_pools?${query({ include: "base_token", duration: "24h", page: 1 })}`)),
    );
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

type Rel = { data?: { id?: unknown } };

export function parseTrendingPools(json: unknown): TrendingPool[] {
  const j = json as { data?: unknown; included?: unknown };
  if (!j || !Array.isArray(j.data)) throw new Error("geckoterminal: malformed trending_pools response");
  const tokens = new Map<string, Record<string, unknown>>();
  for (const inc of Array.isArray(j.included) ? (j.included as Array<{ id?: unknown; type?: unknown; attributes?: Record<string, unknown> }>) : []) {
    if (inc.type === "token" && typeof inc.id === "string" && inc.attributes) tokens.set(inc.id, inc.attributes);
  }
  const out: TrendingPool[] = [];
  for (const p of j.data as Array<{ attributes?: Record<string, unknown>; relationships?: Record<string, Rel> }>) {
    const a = p.attributes ?? {};
    const tokenId = str(p.relationships?.base_token?.data?.id);
    const token = tokenId ? tokens.get(tokenId) : undefined;
    const symbol = str(token?.symbol);
    const network = str(p.relationships?.network?.data?.id) ?? (tokenId?.split("_")[0] || null);
    const address = str(a.address);
    if (!symbol || !network) continue;
    out.push({
      symbol: symbol.toUpperCase(),
      tokenName: str(token?.name) ?? symbol,
      network,
      poolName: str(a.name) ?? symbol,
      volume24hUsd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24) ?? 0,
      reserveUsd: num(a.reserve_in_usd) ?? 0,
      priceChange24hPercent: num((a.price_change_percentage as Record<string, unknown> | undefined)?.h24),
      url: address ? `https://www.geckoterminal.com/${network}/pools/${address}` : null,
    });
  }
  return out;
}
