import { ApiError } from "@/lib/api";
import { RpcError } from "@/lib/chain/client";
import { TxFailed } from "@/lib/chain/outcome";
import { rateLimitMessage } from "@/lib/rate-limit";
import { RelayerError } from "./relayer";
import { AccountNotFoundError, PasskeyOnlyError, SessionExpiredError } from "./service";
import { PasskeyCancelled, PasskeyUnsupported } from "./webauthn";

/**
 * Plain words for every failure people can act on: the account contract's and the markets'
 * refusals, the relayer's, the passkey's and the network's.
 */

const CONTRACT: Array<[RegExp, string]> = [
  [/daily limit exceeded/, "This would put more into trades today than your session allows (500 USDC a day). The allowance resets at midnight UTC, and closing positions does not count."],
  [/session expired/, "Your trading session ended. Renew it with your passkey."],
  [/not a session key|session keys only|unknown session/, "This device's session key is no longer on your account. Renew the session with your passkey."],
  [/sessions are frozen/, "Trading sessions on this account are frozen. Unfreeze them in Settings with your passkey."],
  [/action outside the session scope/, "Your trading session is not allowed to do that. Your passkey can."],
  [/swap output below the minimum/, "The price moved past your limit before it filled, so nothing traded and your funds stayed put."],
  [/index stale/, "The attention index is between reports, so this market waits for the next one, usually within a minute. Nothing was spent."],
  [/price not acceptable/, "The index moved past your limit before the trade landed, so nothing opened. Nothing was spent."],
  [/margin too small/, "That margin is below the smallest the perps take (1 USDC after the fee)."],
  [/size too small/, "That position is too small to open."],
  [/open interest cap/, "This side of the market is at its open interest cap right now. Try a smaller size, or the other side."],
  [/too many open positions/, "This account holds the most open positions a market allows. Close one first."],
  [/market expired|series expired/, "This series has closed for trading. It settles once the oracle records the closing reading."],
  [/trend not active/, "This trend is no longer active, so new trades on it are closed."],
  [/curve closed/, "The curve is full and graduating, so it takes no new trades."],
  [/insufficient balance/, "Not enough balance for that."],
  [/stale mark/, "Tredio's oracle price for this asset is more than two minutes old, so session orders on it wait for the next report. Try again in a minute."],
  [/price outside 2% of the mark/, "This order is priced more than 2% away from the oracle's mark, which session orders may not be. Refresh the price and try again."],
  [/no mark for asset/, "Tredio's oracle has no price for this asset yet, so session orders on it are paused."],
  [/leverage above 10x/, "Session orders on Hyperliquid go up to 10x leverage."],
  [/faucet cooldown/, "This account drew test USDC a short while ago. The faucet pays once per cooldown."],
  [/the faucet is testnet only/, "The faucet runs on testnet only."],
  [/receiver is not registered for storage|owner is not registered for storage/, "This account has not registered with that contract yet. Try again; the app registers it first."],
  [/nothing to claim/, "There is nothing to claim yet."],
  [/registry unavailable/, "The registry could not be read, so nothing was done. Try again."],
  [/gas balance ran low|GasKey/i, "The session's gas ran low and is being refilled. Try again in a moment."],
  [/does not hold enough NEAR/, "The account does not hold enough NEAR for this."],
];

/** The contract's own reason in plain words, or the reason itself. */
export function describeReason(reason: string): string {
  for (const [re, text] of CONTRACT) if (re.test(reason)) return text;
  const r = reason.trim();
  return r ? `${r.charAt(0).toUpperCase()}${r.slice(1)}${/[.!?]$/.test(r) ? "" : "."}` : "The transaction failed.";
}

export function describeError(e: unknown): string {
  if (e instanceof PasskeyCancelled) return e.message;
  if (e instanceof PasskeyUnsupported || e instanceof PasskeyOnlyError || e instanceof AccountNotFoundError) return e.message;
  if (e instanceof SessionExpiredError) return "Your trading session ended. Renew it with your passkey.";
  if (e instanceof TxFailed) return describeReason(e.message);
  if (e instanceof RelayerError) {
    if (e.status === 0) return e.message;
    if (e.status === 429) return rateLimitMessage(e.message, e.retryAfter);
    if (/activation ticket/i.test(e.message)) return "Tredio could not confirm this new account in time. Try creating it again.";
    if (/passkey proof does not match/i.test(e.message)) return "The passkey's signature did not match the request. Try again.";
    if (/too old or from the future/i.test(e.message)) return "This device's clock is off, so the request looked stale. Set the clock to automatic and try again.";
    return describeReason(e.message.replace(/^the transaction failed: /, ""));
  }
  if (e instanceof ApiError) return e.message;
  if (e instanceof RpcError) return "NEAR could not be reached just now. Check your connection and try again.";
  const text = e instanceof Error ? e.message : "";
  if (/fetch failed|network ?error|failed to fetch|load failed|timed? ?out/i.test(text)) return "NEAR could not be reached. Check your connection and try again.";
  return text ? describeReason(text) : "Something went wrong.";
}
