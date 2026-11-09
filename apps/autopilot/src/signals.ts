import { identityOfLeader, openSignal, type Signal, signalHoldings, viewingKey } from "@tredio/autopilot";
import type { AccountState, HlNetwork } from "@tredio/hyperliquid";
import type { LeaderSource } from "./copier";
import type { Sql } from "./db";
import type { Log } from "./log";

/**
 * Signal channels as copy-trading leaders. A follow whose leader is `signals:<identity>` copies a
 * leader's paid signals instead of a trader's account: the executor opens the leader's sealed
 * signals with the weekly viewing keys (it derives them from the same SIGNALS_SECRET the API sells
 * them from) and adds them up into positions with `signalHoldings`, which the copier diffs like any
 * leader's. Signals are priced at the trading network's mark when the API took them, so copies are
 * held to that price within the follow's slippage, as for a leader on the trading network.
 *
 * Only followers whose early access is active have their follow active: the API refuses the follow
 * without access and pauses it when access ends.
 */

/** How far back signals count towards a leader's positions: an opening older than this without a close lapses, and its copies close. */
export const SIGNAL_LOOKBACK_SEC = 30 * 86_400;

interface SealedRow {
  commitment: string;
  epoch: number;
  iv: string;
  ciphertext: string;
}

/** The positions a signal channel's signals add up to, as Hyperliquid's account state shape. */
export function signalState(signals: readonly Signal[], nowMs: number): AccountState {
  const positions = [...signalHoldings(signals)].map(([coin, h]) => {
    const entry = h.entryPrice ?? 0;
    return {
      coin,
      szi: h.side === "long" ? h.size : -h.size,
      entryPx: h.entryPrice ?? null,
      positionValue: h.size * entry,
      unrealizedPnl: 0,
      marginUsed: h.marginUsdc,
      leverage: h.marginUsdc > 0 ? (h.size * entry) / h.marginUsdc : 0,
      liquidationPx: null,
    };
  });
  const margin = positions.reduce((t, p) => t + p.marginUsed, 0);
  return { accountValue: margin, withdrawable: 0, totalMarginUsed: margin, positions, time: nowMs };
}

/**
 * A LeaderSource for signal channels, on top of `others` for every other leader. Signals that do not
 * open (a wrong key or a commitment that does not match) are left out and logged once.
 */
export function signalLeaders(o: { sql: Sql; secret: Uint8Array; network: HlNetwork; others: LeaderSource; now?: () => number; log?: Log }): LeaderSource {
  const now = o.now ?? Date.now;
  const keys = new Map<string, string>();
  const broken = new Set<string>();
  const keyFor = async (identity: string, epoch: number) => {
    const id = `${identity}:${epoch}`;
    let k = keys.get(id);
    if (!k) {
      k = await viewingKey(o.secret, identity, epoch);
      keys.set(id, k);
    }
    return k;
  };
  return {
    state: async (leader) => {
      const identity = identityOfLeader(leader);
      if (!identity) return o.others.state(leader);
      const since = Math.floor(now() / 1000) - SIGNAL_LOOKBACK_SEC;
      const rows = await o.sql<SealedRow[]>`
        SELECT commitment, epoch, iv, ciphertext FROM signals WHERE leader = ${identity} AND hidden_at IS NULL AND issued_at > ${since} ORDER BY issued_at`;
      const signals: Signal[] = [];
      for (const r of rows) {
        try {
          signals.push(await openSignal(await keyFor(identity, r.epoch), { iv: r.iv, ciphertext: r.ciphertext }, r.commitment));
        } catch {
          if (!broken.has(r.commitment)) o.log?.warn({ leader, commitment: r.commitment }, "a signal did not open with its week's key: left out");
          broken.add(r.commitment);
        }
      }
      return { network: o.network, state: signalState(signals, now()) };
    },
    marks: (network) => o.others.marks(network),
  };
}
