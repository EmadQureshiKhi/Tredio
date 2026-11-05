import { Polite, type PoliteOptions, TtlCache } from "./polite";

/**
 * CoinGecko's trending search list (https://docs.coingecko.com/reference/trending-search), keyless
 * on the public API: the coins, NFT collections and categories people search most on CoinGecko in
 * the last 24 hours. The list changes slowly and the public API allows a few calls a minute, so it
 * is fetched at most once every ten minutes. CoinGecko's terms require attribution wherever its
 * data is shown: candidates it surfaced carry COINGECKO_ATTRIBUTION.
 */

export const COINGECKO_API = "https://api.coingecko.com/api/v3";
export const COINGECKO_ATTRIBUTION = { text: "Data from CoinGecko", url: "https://www.coingecko.com" } as const;
const TTL_MS = 10 * 60_000;

export interface TrendingCoin {
  id: string;
  symbol: string;
  name: string;
  marketCapRank: number | null;
  /** Position in CoinGecko's list, 0 first. */
  score: number;
  priceChange24hPercent: number | null;
}

export interface TrendingCategory {
  name: string;
  slug: string | null;
  marketCapChange24hPercent: number | null;
}

export interface TrendingNft {
  id: string;
  name: string;
  symbol: string | null;
}

export interface CoinGeckoTrending {
  coins: TrendingCoin[];
  nfts: TrendingNft[];
  categories: TrendingCategory[];
}

export class CoinGecko {
  readonly http: Polite;
  private readonly cache: TtlCache<CoinGeckoTrending>;

  constructor(
    private readonly baseUrl = COINGECKO_API,
    opts: Partial<PoliteOptions> = {},
  ) {
    // The keyless public API allows a handful of calls a minute; this client makes one per ten.
    this.http = new Polite("coingecko", { spacingMs: 15_000, ...opts });
    this.cache = new TtlCache(TTL_MS, opts.now);
  }

  trending(): Promise<CoinGeckoTrending> {
    return this.cache.get(async () => parseTrending(await this.http.json(`${this.baseUrl}/search/trending`)));
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

export function parseTrending(json: unknown): CoinGeckoTrending {
  const j = json as { coins?: unknown; nfts?: unknown; categories?: unknown };
  if (!j || !Array.isArray(j.coins)) throw new Error("coingecko: malformed trending response");
  const coins: TrendingCoin[] = [];
  for (const [i, row] of (j.coins as Array<{ item?: Record<string, unknown> }>).entries()) {
    const c = row?.item;
    const id = str(c?.id);
    const symbol = str(c?.symbol);
    const name = str(c?.name);
    if (!c || !id || !symbol || !name) continue;
    const change = (c.data as { price_change_percentage_24h?: Record<string, unknown> } | undefined)?.price_change_percentage_24h?.usd;
    coins.push({ id, symbol: symbol.toUpperCase(), name, marketCapRank: num(c.market_cap_rank), score: num(c.score) ?? i, priceChange24hPercent: num(change) });
  }
  const nfts: TrendingNft[] = [];
  for (const n of Array.isArray(j.nfts) ? (j.nfts as Array<Record<string, unknown>>) : []) {
    const id = str(n.id);
    const name = str(n.name);
    if (id && name) nfts.push({ id, name, symbol: str(n.symbol) });
  }
  const categories: TrendingCategory[] = [];
  for (const c of Array.isArray(j.categories) ? (j.categories as Array<Record<string, unknown>>) : []) {
    const name = str(c.name);
    if (!name) continue;
    const change = (c.data as { market_cap_change_percentage_24h?: Record<string, unknown> } | undefined)?.market_cap_change_percentage_24h?.usd;
    categories.push({ name, slug: str(c.slug), marketCapChange24hPercent: num(change) });
  }
  return { coins, nfts, categories };
}
