import { type Rule, type RuleInput, ruleSchema } from "@tredio/autopilot";
import type { Trend } from "@/lib/api";
import { baseIdentifier, newestListing } from "@/lib/trends";
import { capitalize } from "../shared/rule-text";

/**
 * The rule builder's form: strings while typing, a RuleInput once parsed. Validation is the
 * backend's own schema, so the form refuses exactly what the server would.
 */

export interface Draft {
  name: string;
  trend: string;
  market: string;
  direction: "up" | "down";
  change: string;
  windowMin: number;
  minIndex: string;
  smartMoney: "any" | "buying" | "selling";
  side: "long" | "short";
  margin: string;
  leverage: string;
  stopLoss: string;
  takeProfit: string;
  maxHoldMin: number;
  maxPosition: string;
  maxDailyLoss: string;
  cooldown: string;
}

export const WINDOWS = [15, 30, 60, 240, 720, 1440, 4320] as const;
export const HOLDS = [0, 60, 240, 720, 1440, 4320, 10080] as const;

export const DEFAULT_DRAFT: Draft = {
  name: "",
  trend: "crypto:eth",
  market: "ETH",
  direction: "up",
  change: "30",
  windowMin: 60,
  minIndex: "0",
  smartMoney: "any",
  side: "long",
  margin: "20",
  leverage: "2",
  stopLoss: "5",
  takeProfit: "10",
  maxHoldMin: 0,
  maxPosition: "100",
  maxDailyLoss: "20",
  cooldown: "30",
};

const s = (v: number) => String(Number.isInteger(v) ? v : Number(v.toFixed(4)));

export function draftFromRule(r: RuleInput): Draft {
  const change = r.entry.attentionChangePct;
  return {
    name: r.name,
    trend: r.trend,
    market: r.market,
    direction: change < 0 ? "down" : "up",
    change: s(Math.abs(change)),
    windowMin: r.entry.windowMin,
    minIndex: s(r.entry.minIndex ?? 0),
    smartMoney: r.entry.smartMoney ?? "any",
    side: r.entry.side,
    margin: s(r.size.marginUsdc),
    leverage: s(r.size.leverage),
    stopLoss: s(r.exits.stopLossPct),
    takeProfit: s(r.exits.takeProfitPct),
    maxHoldMin: r.exits.maxHoldMin ?? 0,
    maxPosition: s(r.limits.maxPositionUsdc),
    maxDailyLoss: s(r.limits.maxDailyLossUsdc),
    cooldown: s(r.limits.cooldownMin ?? 30),
  };
}

export const autoName = (d: Pick<Draft, "side" | "market" | "trend">, trendName: string) => `${d.side === "long" ? "Long" : "Short"} ${d.market} on ${trendName} attention`.slice(0, 60);

/** Field keys of the draft, by the schema path they fill. */
const FIELD: Record<string, keyof Draft> = {
  name: "name",
  market: "market",
  trend: "trend",
  "entry.attentionChangePct": "change",
  "entry.windowMin": "windowMin",
  "entry.minIndex": "minIndex",
  "entry.smartMoney": "smartMoney",
  "entry.side": "side",
  "size.marginUsdc": "margin",
  "size.leverage": "leverage",
  "exits.stopLossPct": "stopLoss",
  "exits.takeProfitPct": "takeProfit",
  "exits.maxHoldMin": "maxHoldMin",
  "limits.maxPositionUsdc": "maxPosition",
  "limits.maxDailyLossUsdc": "maxDailyLoss",
  "limits.cooldownMin": "cooldown",
};

export const LABEL: Record<keyof Draft, string> = {
  name: "Name",
  trend: "Trend",
  market: "Market",
  direction: "Direction",
  change: "Attention change",
  windowMin: "Window",
  minIndex: "Minimum index",
  smartMoney: "Smart money",
  side: "Side",
  margin: "Margin",
  leverage: "Leverage",
  stopLoss: "Stop loss",
  takeProfit: "Take profit",
  maxHoldMin: "Time limit",
  maxPosition: "Maximum position",
  maxDailyLoss: "Daily loss limit",
  cooldown: "Cooldown",
};

type Issue = { code: string; message: string; path: PropertyKey[]; minimum?: number | bigint; maximum?: number | bigint; inclusive?: boolean; origin?: string };

/** Zod's range messages in plain words; the schema's own messages stay as written. */
function humanize(i: Issue): string {
  if (i.code === "custom") return capitalize(i.message);
  if (i.code === "invalid_type") return "Enter a number";
  if (i.code === "too_small" && i.origin === "string") return "Give it a name";
  if (i.code === "too_big" && i.origin === "string") return "Keep it under 60 characters";
  if (i.code === "too_small") return i.inclusive === false || Number(i.minimum) === 0 ? `Must be more than ${Number(i.minimum)}` : `Must be at least ${Number(i.minimum)}`;
  if (i.code === "too_big") return `Must be at most ${Number(i.maximum)}`;
  if (i.code === "invalid_format") return "Pick one from the list";
  if (i.code === "invalid_value") return "Pick one from the list";
  return capitalize(i.message);
}

const NUMERIC: Array<keyof Draft> = ["change", "minIndex", "margin", "leverage", "stopLoss", "takeProfit", "maxPosition", "maxDailyLoss", "cooldown"];
const num = (v: string) => (v.trim() === "" || v.trim() === "." ? Number.NaN : Number(v));

export interface Parsed {
  input: RuleInput;
  rule: Rule | null;
  errors: Partial<Record<keyof Draft, string>>;
  /** Stable text of the parsed rule, to tell whether a backtest or a save still matches it. */
  key: string | null;
}

/**
 * Validates a draft as the backend will: the rule schema, the market's leverage limit and, since
 * rules trade through the account's Autopilot session, the session's leverage cap.
 */
export function parseDraft(d: Draft, fallbackName: string, opts: { maxLeverage?: number | null; sessionMaxLeverage?: number | null; maintenanceMargin?: number | null } = {}): Parsed {
  const change = num(d.change);
  const input: RuleInput = {
    name: d.name.trim() || fallbackName,
    market: d.market,
    trend: d.trend,
    entry: { attentionChangePct: d.direction === "down" ? -change : change, windowMin: d.windowMin, minIndex: num(d.minIndex), smartMoney: d.smartMoney, side: d.side },
    size: { marginUsdc: num(d.margin), leverage: num(d.leverage) },
    exits: { stopLossPct: num(d.stopLoss), takeProfitPct: num(d.takeProfit), maxHoldMin: d.maxHoldMin },
    limits: { maxPositionUsdc: num(d.maxPosition), maxDailyLossUsdc: num(d.maxDailyLoss), cooldownMin: num(d.cooldown) },
  };
  const errors: Parsed["errors"] = {};
  for (const k of NUMERIC) if (!Number.isFinite(num(d[k] as string))) errors[k] = "Enter a number";
  if (d.direction === "down" && change > 90) errors.change = "Attention can fall at most 90%";
  const res = ruleSchema.safeParse(input);
  if (!res.success) {
    for (const i of res.error.issues as Issue[]) {
      const field = FIELD[i.path.join(".")];
      if (field && !errors[field]) errors[field] = humanize(i);
    }
  }
  const lev = num(d.leverage);
  if (opts.maxLeverage && Number.isFinite(lev) && lev > opts.maxLeverage && !errors.leverage) errors.leverage = `The market allows at most ${opts.maxLeverage}x on ${d.market}`;
  if (opts.sessionMaxLeverage && Number.isFinite(lev) && lev > opts.sessionMaxLeverage && !errors.leverage) errors.leverage = `Autopilot opens at up to ${opts.sessionMaxLeverage}x from your account`;
  // The schema allows for leverage alone; the market liquidates earlier, at its maintenance margin.
  const stop = num(d.stopLoss);
  if (opts.maintenanceMargin && Number.isFinite(lev) && lev >= 1 && Number.isFinite(stop) && !errors.stopLoss) {
    const liq = (1 / lev - opts.maintenanceMargin) * 100;
    if (stop >= liq) errors.stopLoss = `A ${stop}% stop at ${lev}x is beyond the market's liquidation (about ${liq.toFixed(1)}%); lower the stop or the leverage`;
  }
  const ok = res.success && Object.keys(errors).length === 0;
  return { input, rule: ok ? res.data : null, errors, key: ok ? canonical(res.data) : null };
}

/** JSON with sorted keys, the same canonical form the backend hashes. */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, y]) => [k, sort(y)]),
        )
      : x;
  return JSON.stringify(sort(v));
}

/** The parsed form of a saved rule, for comparing with the form. */
export function keyOf(r: RuleInput): string | null {
  const res = ruleSchema.safeParse(r);
  return res.success ? canonical(res.data) : null;
}

/**
 * Where a new rule starts: the hottest live trend whose own coin has an asset perp (trading that coin),
 * else the hottest live trend on the default market. Nothing live keeps the defaults.
 */
export function liveDefault(list: Trend[], symbols: string[]): Partial<Draft> {
  const topics = [...new Set(list.map((t) => baseIdentifier(t.identifier)))].map((base) => newestListing(list, base)!).filter((t) => t.status !== "retired");
  const hottest = topics.sort((a, b) => b.index - a.index);
  const listed = hottest.find((t) => t.ticker && symbols.includes(t.ticker));
  if (listed) return { trend: baseIdentifier(listed.identifier), market: listed.ticker! };
  const any = hottest[0];
  if (!any) return {};
  return { trend: baseIdentifier(any.identifier), ...(symbols.length && !symbols.includes(DEFAULT_DRAFT.market) ? { market: symbols[0]! } : {}) };
}

/** A backtest caveat for people: ISO timestamps become local dates, and it reads as a sentence. */
export function readableWarning(w: string): string {
  const text = w.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g, (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The smallest attention move a loosened trigger asks for, in percent. */
const MIN_LOOSE_CHANGE = 5;

/**
 * A looser trigger for a rule that never fired in its backtest: half the attention move (not
 * below 5%), the next longer window, no minimum index and smart money ignored. Each change is
 * named for the suggestion's label; null when the trigger is as loose as it goes.
 */
export function loosenTrigger(d: Draft): { draft: Draft; changes: string[] } | null {
  const next = { ...d };
  const changes: string[] = [];
  const change = Number(d.change);
  if (Number.isFinite(change) && change > MIN_LOOSE_CHANGE) {
    next.change = String(Math.max(MIN_LOOSE_CHANGE, Math.round(change / 2)));
    changes.push(`${next.change}% move`);
  }
  const wider = WINDOWS.find((w) => w > d.windowMin);
  if (wider !== undefined) {
    next.windowMin = wider;
    changes.push(`${windowWords(wider)} window`);
  }
  if (Number(d.minIndex) > 0) {
    next.minIndex = "0";
    changes.push("no minimum index");
  }
  if (d.smartMoney !== "any") {
    next.smartMoney = "any";
    changes.push("any smart money");
  }
  return changes.length ? { draft: next, changes } : null;
}

const windowWords = (min: number) => (min % 1440 === 0 ? (min === 1440 ? "24 hour" : `${min / 1440} day`) : min % 60 === 0 ? (min === 60 ? "1 hour" : `${min / 60} hour`) : `${min} minute`);
