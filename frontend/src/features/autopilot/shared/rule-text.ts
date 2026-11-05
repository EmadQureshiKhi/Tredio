import type { RuleInput, StoredRule } from "@/lib/api";
import { usdc, price } from "@/lib/format";
import { baseIdentifier, trendName } from "@/lib/trends";

/** Rules and Autopilot events in plain words. */

export function duration(min: number): string {
  if (min <= 0) return "no limit";
  if (min % 1440 === 0) return min === 1440 ? "24 hours" : `${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "1 hour" : `${min / 60} hours`;
  return `${min} min`;
}

export function shortDuration(min: number): string {
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

/** "Long ETH 2x when attention rises 30% in 1h". */
export function ruleHeadline(r: RuleInput): string {
  const change = r.entry.attentionChangePct;
  return `${r.entry.side === "long" ? "Long" : "Short"} ${r.market} ${num(r.size.leverage)}x when attention ${change > 0 ? "rises" : "falls"} ${num(Math.abs(change))}% in ${shortDuration(r.entry.windowMin)}`;
}

/** The whole rule as one paragraph. */
export function ruleSentence(r: RuleInput, trendName: string): string {
  const change = r.entry.attentionChangePct;
  const smart = r.entry.smartMoney === "buying" ? " and smart money is buying" : r.entry.smartMoney === "selling" ? " and smart money is selling" : "";
  const floor = r.entry.minIndex ? `, while the index is at least ${num(r.entry.minIndex)}` : "";
  const hold = r.exits.maxHoldMin ? `, or after ${duration(r.exits.maxHoldMin)}` : "";
  return (
    `When attention on ${trendName} ${change > 0 ? "rises" : "falls"} ${num(Math.abs(change))}% within ${duration(r.entry.windowMin)}${floor}${smart}, ` +
    `open a ${num(r.size.leverage)}x ${r.entry.side} on ${r.market} with ${num(r.size.marginUsdc)} USDC margin. ` +
    `Close at a ${num(r.exits.stopLossPct)}% loss or a ${num(r.exits.takeProfitPct)}% gain${hold}.`
  );
}

export const STATUS_LABEL: Record<StoredRule["status"], string> = { draft: "Draft", enabled: "Running", paused: "Paused", stopped: "Stopped" };
export const STATUS_TONE = { draft: "neutral", enabled: "up", paused: "warn", stopped: "down" } as const;

export const CLOSE_REASON: Record<string, string> = {
  stop: "Stop loss",
  take_profit: "Take profit",
  max_hold: "Time limit",
  kill: "Stopped",
  end_of_data: "End of data",
  "closed outside Autopilot": "Closed outside",
  loss_cap: "Loss cap",
};
export const closeReason = (r: string | null | undefined) => (r ? (CLOSE_REASON[r] ?? r.replace(/_/g, " ")) : "-");

export type EventTone = "neutral" | "primary" | "up" | "down" | "warn";
export interface EventView {
  title: string;
  body: string | null;
  tone: EventTone;
  tx: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const numOr = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sizeText = (v: unknown) => {
  const n = numOr(v);
  return n === null ? null : n >= 1 ? num(Number(n.toFixed(4))) : String(Number(n.toPrecision(3)));
};

/** One audit-log entry as a title and a sentence. */
export function describeEvent(event: string, detail: Record<string, unknown>): EventView {
  const reason = str(detail.reason);
  const tx = str(detail.tx);
  const side = str(detail.side);
  const action = str(detail.action);
  const by = str(detail.by);
  switch (event) {
    case "rule_created":
      return { title: "Rule created", body: "Saved as a draft.", tone: "neutral", tx: null };
    case "rule_edited":
      return { title: "Rule edited", body: "Its earlier backtest no longer applies.", tone: "neutral", tx: null };
    case "rule_enabled": {
      const bt = detail.backtest as { trades?: number; pnlUsdc?: number } | undefined;
      return { title: "Switched on", body: bt ? `Backtest before enabling: ${bt.trades ?? 0} trade${bt.trades === 1 ? "" : "s"}, ${usdc(bt.pnlUsdc ?? 0, { sign: true })} USDC.` : null, tone: "up", tx: null };
    }
    case "rule_paused":
      return { title: by === "autopilot" ? "Paused by Autopilot" : "Paused", body: reason ? humanReason(reason).text : "Opens nothing new; an open position still exits on its stop or target.", tone: "warn", tx: null };
    case "rule_stopped":
      return { title: "Stopped", body: "Any open position closes at the market price.", tone: "down", tx: null };
    case "waiting":
      return { title: "Waiting", body: reason ? capitalize(reason) : null, tone: "neutral", tx: null };
    case "entry_signal": {
      const lev = numOr(detail.leverage);
      const margin = numOr(detail.marginUsdc);
      const p = numOr(detail.price);
      return {
        title: "Entry signal",
        body: [reason ? capitalize(reason) : null, margin !== null && lev !== null ? `${usdc(margin)} USDC margin at ${num(lev)}x` : null, p !== null ? `price ${price(p)}` : null].filter(Boolean).join(", "),
        tone: "primary",
        tx: null,
      };
    }
    case "exit_signal": {
      const move = numOr(detail.movePct);
      return { title: "Exit signal", body: [reason ? closeReason(reason) : null, move !== null ? `price ${move >= 0 ? "+" : ""}${move.toFixed(1)}% from entry` : null].filter(Boolean).join(", "), tone: "primary", tx: null };
    }
    case "order_sent":
      return { title: "Order sent", body: [action ? capitalize(action) : null, side, sizeText(detail.size)].filter(Boolean).join(" "), tone: "neutral", tx };
    case "order_filled": {
      const p = numOr(detail.price);
      const pnl = numOr(detail.pnlUsdc);
      const fee = numOr(detail.feeUsdc);
      return {
        title: "Order filled",
        body: [action ? `${capitalize(action)} ${side ?? ""}`.trim() : null, p !== null ? `at ${price(p)}` : null, pnl !== null && action !== "open" ? `PnL ${usdc(pnl, { sign: true })} USDC` : null, fee !== null ? `fee ${usdc(fee)}` : null]
          .filter(Boolean)
          .join(", "),
        tone: pnl !== null && action !== "open" ? (pnl >= 0 ? "up" : "down") : "up",
        tx,
      };
    }
    case "order_unfilled":
      return { title: "Order not filled", body: str(detail.error) ?? "No liquidity within the price limit.", tone: "warn", tx };
    case "order_failed":
      return { title: "Order failed", body: str(detail.error) ? humanReason(str(detail.error)!).text : null, tone: "down", tx };
    case "order_retry":
      return { title: "Retrying order", body: str(detail.error), tone: "warn", tx: null };
    case "order_skipped":
      return { title: "Order skipped", body: reason ? capitalize(reason) : null, tone: "warn", tx: null };
    case "funding_failed":
      return { title: "Could not post margin", body: str(detail.error) ? humanReason(str(detail.error)!).text : null, tone: "down", tx: null };
    case "position_closed_externally":
      return { title: "Position closed outside Autopilot", body: "Closed by hand on the market, or liquidated.", tone: "warn", tx: null };
    case "position_reduced_externally":
      return { title: "Position reduced outside Autopilot", body: null, tone: "warn", tx: null };
    case "copy_skipped":
      return { title: "Copy skipped", body: reason ? capitalize(reason) : null, tone: "warn", tx: null };
    case "copy_loss_cap": {
      const pnl = numOr(detail.openPnlUsdc);
      const cap = numOr(detail.capUsdc);
      return { title: "Loss cap reached", body: pnl !== null && cap !== null ? `Open copies were down ${usdc(-pnl)} USDC against a ${usdc(cap)} USDC cap: closed and paused.` : "Open copies closed and the follow paused.", tone: "down", tx: null };
    }
    default:
      return { title: capitalize(event.replace(/_/g, " ")), body: reason, tone: "neutral", tx };
  }
}

export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Why Autopilot paused or failed, in words a user can act on; raw errors lose their hex. */
export function humanReason(reason: string): { text: string; needsFunds: boolean; needsGrant: boolean } {
  if (/InsufficientBalance|insufficient (balance|funds)|exceeds balance/i.test(reason)) {
    return { text: "Not enough USDC in your account to post the margin. Add funds, then resume.", needsFunds: true, needsGrant: false };
  }
  if (/daily limit|spent today/i.test(reason)) return { text: "Autopilot reached its daily USDC cap. It can trade again tomorrow, or renew access with a higher cap.", needsFunds: false, needsGrant: true };
  if (/outside the price band|stale mark/i.test(reason)) {
    return { text: "The market's price was moving too fast for a safe order (more than 2% from its mark, or a stale mark). Autopilot tries again on its next check.", needsFunds: false, needsGrant: false };
  }
  if (/no active Autopilot grant|grant/i.test(reason)) return { text: "Autopilot has no access to your account. Grant it, then resume.", needsFunds: false, needsGrant: true };
  const clean = reason.replace(/\b[0-9a-fA-F]{40,}\b/g, (h) => `${h.slice(0, 6)}...${h.slice(-4)}`);
  return { text: capitalize(clean.length > 180 ? `${clean.slice(0, 177)}...` : clean), needsFunds: false, needsGrant: false };
}

/** The trend's display name, from the live list when present. */
export function trendLabel(identifier: string, trends: ReadonlyArray<{ identifier: string; displayName: string | null }> | undefined): string {
  // A relisted trend carries a version suffix (crypto:eth.2); rules name the base identifier.
  const t = trends?.find((x) => x.identifier === identifier) ?? trends?.find((x) => baseIdentifier(x.identifier) === baseIdentifier(identifier));
  return t ? trendName(t) : baseIdentifier(identifier);
}
