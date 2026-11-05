import type { KeyRing } from "../budget";
import { BudgetError, type Fetch, HttpError, isKeyRejected, isQuotaError, isThrottled } from "./http";

/**
 * Nansen smart-money netflows (https://docs.nansen.ai/api/smart-money/netflows): net USD flow of
 * smart-money wallets per token over 24 hours. The token filter takes contract addresses, not
 * tickers, so one call (5 credits) reads every token smart money traded (up to 1,000 rows across
 * chains, tokens above $1M market cap, most-traded first) and flows are summed per ticker. A
 * ticker missing from the result had no smart-money activity: its flow is zero.
 */

export const NETFLOW_CREDITS = 5;

export class Nansen {
  constructor(
    private readonly ring: KeyRing,
    private readonly baseUrl: string,
    private readonly chains: readonly string[],
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** Net 24h smart-money flow (USD) per upper-case ticker; tickers smart money did not trade are absent. */
  async netflow(): Promise<Map<string, number>> {
    const body = JSON.stringify(netflowBody(this.chains));
    for (let attempt = 0; attempt < this.ring.size; attempt++) {
      const lease = await this.ring.take(NETFLOW_CREDITS);
      if (!lease) throw new BudgetError("nansen");
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/v1/smart-money/netflow`, {
          method: "POST",
          headers: { apikey: lease.key, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        // Nansen reports the key's balance; a key that cannot pay for another call rests until tomorrow.
        const remaining = Number(res.headers.get("x-nansen-credits-remaining"));
        if (res.headers.has("x-nansen-credits-remaining") && Number.isFinite(remaining) && remaining < NETFLOW_CREDITS) this.ring.exhaust(lease.keyId);
        if (!res.ok) throw new HttpError("nansen", res.status, text);
        return parseNetflow(JSON.parse(text) as { data?: Array<Record<string, unknown>> });
      } catch (e) {
        if (isKeyRejected(e)) this.ring.reject(lease.keyId);
        else if (isQuotaError(e)) this.ring.exhaust(lease.keyId);
        else if (isThrottled(e)) this.ring.rest(lease.keyId);
        else throw e;
      }
    }
    throw new BudgetError("nansen");
  }
}

export function netflowBody(chains: readonly string[]) {
  return {
    chains,
    filters: { include_native_tokens: true, include_stablecoins: false, market_cap_usd: { min: 1_000_000 } },
    order_by: [{ field: "trader_count", direction: "DESC" }],
    pagination: { page: 1, per_page: 1000 },
  };
}

/** Wrapped forms, and copies of a token on other networks, count toward the asset they stand for. */
export const TICKER_ALIASES: Record<string, string> = {
  WBTC: "BTC",
  CBBTC: "BTC",
  BTCB: "BTC",
  TBTC: "BTC",
  WETH: "ETH",
  WSOL: "SOL",
};

export function parseNetflow(json: { data?: Array<Record<string, unknown>> }): Map<string, number> {
  if (!Array.isArray(json.data)) throw new Error("nansen: malformed netflow response");
  const out = new Map<string, number>();
  for (const row of json.data) {
    const symbol = row.token_symbol;
    const flow = row.net_flow_24h_usd;
    if (typeof symbol !== "string" || typeof flow !== "number" || !Number.isFinite(flow)) continue;
    const key = TICKER_ALIASES[symbol.toUpperCase()] ?? symbol.toUpperCase();
    out.set(key, (out.get(key) ?? 0) + flow);
  }
  return out;
}
