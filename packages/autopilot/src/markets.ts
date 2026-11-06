/**
 * The Hyperliquid markets Autopilot trades, for rules and copies alike. Every order goes through
 * the account contract's order guard, which refuses one without a fresh registry mark for its
 * asset, and Tredio's oracle marks exactly these in every report (its MARK_ASSETS default, and the
 * enclave build's own list). It marks other assets only while a live trend names them, so a rule
 * or a copy in any other market could wait for a mark indefinitely: both refuse them up front.
 */
export const AUTOPILOT_MARKETS = ["BTC", "ETH", "SOL", "NEAR", "HYPE"] as const;

export type AutopilotMarket = (typeof AUTOPILOT_MARKETS)[number];

/** The markets in words: "BTC, ETH, SOL, NEAR and HYPE". */
export const AUTOPILOT_MARKETS_TEXT = `${AUTOPILOT_MARKETS.slice(0, -1).join(", ")} and ${AUTOPILOT_MARKETS[AUTOPILOT_MARKETS.length - 1]}`;

export const isAutopilotMarket = (symbol: string): symbol is AutopilotMarket => (AUTOPILOT_MARKETS as readonly string[]).includes(symbol);

/** Why Autopilot does not trade `symbol`, or null when it does. */
export function autopilotMarketProblem(symbol: string): string | null {
  return isAutopilotMarket(symbol) ? null : `${symbol} is not an Autopilot market: Autopilot trades ${AUTOPILOT_MARKETS_TEXT}, the markets Tredio's oracle marks for the account's order guard`;
}
