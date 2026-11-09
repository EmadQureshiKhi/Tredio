import { type Call, calls, type Deployment, opensAtCap } from "@tredio/contracts";
import type { Snapshot } from "./snapshot";

export type ActionKind = "liquidate" | "settleRetired" | "graduate" | "settle" | "retire" | "openSeries" | "list" | "createCurve" | "cancelExpired" | "poke";

/** One transaction the keeper wants to send. */
export interface Action {
  /** Stable identity, so the same work is never sent twice concurrently. */
  key: string;
  kind: ActionKind;
  call: Call;
  reason: string;
  /**
   * Refusals that mean the work is already under way, not that it failed: the action is tried
   * again on the next scan instead of backing off.
   */
  waitsOn?: RegExp;
}

/**
 * The coins factory runs one graduation step at a time per curve and refuses `graduate` while a
 * step's callback is pending (a block or two; a lost one expires after ten minutes).
 */
export const GRADUATION_IN_FLIGHT = /a graduation step is in flight/;

export interface PlanConfig {
  /** Windows the keeper opens series for (seconds). */
  seriesWindows: readonly number[];
  /** Create a trend coin for every active trend. */
  coins: boolean;
  /** Seconds after expiry before settling, so the oracle's settlement observation has landed. */
  settleDelaySec: number;
}

/** Retired positions settled per scan; the rest wait for the next scans (nothing is at risk there). */
export const MAX_RETIRED_SETTLEMENTS = 4;

/**
 * Decides what to send, from one snapshot, in priority order: protect solvency first
 * (liquidations, retired settlements), then pay out (graduations, settlements), then lifecycle,
 * then new markets, then funding marks and housekeeping. Pure, so it is tested without a chain.
 */
export function plan(s: Snapshot, d: Deployment, cfg: PlanConfig): Action[] {
  const C = calls(d);
  const actions: Action[] = [];
  const trendById = new Map(s.trends.map((t) => [t.id, t]));

  for (const p of s.positions) {
    if (!p.state?.liquidatable) continue;
    actions.push({ key: `liquidate:${p.id}`, kind: "liquidate", call: C.perps.liquidate(p.id), reason: `equity ${p.state.equity} below maintenance` });
  }
  let retiredSettlements = 0;
  for (const p of s.positions) {
    if (p.state?.liquidatable || trendById.get(p.trend)?.status !== "retired" || retiredSettlements >= MAX_RETIRED_SETTLEMENTS) continue;
    retiredSettlements++;
    actions.push({ key: `settleRetired:${p.id}`, kind: "settleRetired", call: C.perps.settleRetired(p.id), reason: "trend retired" });
  }

  for (const c of s.curves) {
    if (c.stage === "ready" || c.stage === "pooled") actions.push({ key: `graduate:${c.trend}:${c.stage}`, kind: "graduate", call: C.coins.graduate(c.trend), reason: `curve ${c.stage}`, waitsOn: GRADUATION_IN_FLIGHT });
  }

  for (const l of s.latest) {
    const v = l.series;
    if (v && v.outcome === "open" && s.now >= v.expiry + cfg.settleDelaySec && s.settleable.has(v.id)) {
      actions.push({ key: `settle:${v.id}`, kind: "settle", call: C.outcomes.settle(v.id), reason: `expired at ${v.expiry}` });
    }
  }

  // When every live trend went stale together, the oracle stopped reporting (an outage, not trends that
  // faded): retiring them all would end every market for good, so stale retirement waits for the oracle.
  const live = s.trends.filter((t) => t.status !== "retired");
  const outage = live.length > 1 && live.every((t) => s.now - t.updated_at >= s.params.stale_retire_window);
  for (const t of live) {
    const stale = !outage && s.now - t.updated_at >= s.params.stale_retire_window;
    const cooledOut = t.status === "cooling" && s.now - t.status_since >= s.params.retire_window;
    if (stale || cooledOut) {
      actions.push({ key: `retire:${t.id}`, kind: "retire", call: C.registry.pokeLifecycle(t.id), reason: stale ? "no oracle update within the stale retire window" : "cooling for the retire window" });
    }
  }

  // A window gets its next series once the previous one expired, so the latest one per window is
  // all there is to act on. Only active, fresh trends open series (the registry checks it too), and
  // never at the index cap, where Up could not win.
  for (const l of s.latest) {
    const t = trendById.get(l.trend);
    if (!t || !cfg.seriesWindows.includes(l.window) || !s.windows.includes(l.window)) continue;
    if (t.status !== "active" || s.now - t.updated_at > s.params.staleness_limit || opensAtCap(t.index)) continue;
    if (!l.series || s.now >= l.series.expiry) {
      actions.push({ key: `openSeries:${t.id}:${l.window}`, kind: "openSeries", call: C.outcomes.openSeries(t.id, l.window), reason: l.series ? "previous series expired" : "first series" });
    }
  }

  for (const series of s.unlisted) actions.push({ key: `list:${series}`, kind: "list", call: C.book.listSeries(series), reason: "series has no book markets yet" });

  if (cfg.coins) {
    const withCurve = new Set(s.curves.map((c) => c.trend));
    for (const t of s.trends) {
      if (t.status !== "active" || withCurve.has(t.id) || s.now - t.updated_at > s.params.staleness_limit) continue;
      actions.push({ key: `createCurve:${t.id}`, kind: "createCurve", call: C.coins.createCurve(t.id), reason: "active trend without a coin" });
    }
  }

  // Funding accrues at the mark of the last touch, so a moved index is marked promptly.
  for (const { trend, market } of s.perpMarkets) {
    const t = trendById.get(trend);
    if (!t || t.status === "retired" || (BigInt(market.long_qty) === 0n && BigInt(market.short_qty) === 0n) || market.last_mark === t.index) continue;
    actions.push({ key: `poke:${trend}`, kind: "poke", call: C.perps.poke(trend), reason: `mark ${market.last_mark} behind index ${t.index}` });
  }

  // Twenty orders a call keeps the attached gas, and a gas key's reserve for it, small.
  for (const m of s.expiredMarkets) actions.push({ key: `cancelExpired:${m.series}:${m.side}`, kind: "cancelExpired", call: { ...C.book.cancelExpired(m.series, m.side, 20), gas: (150n * 10n ** 12n).toString() }, reason: "series expired" });

  return actions;
}
