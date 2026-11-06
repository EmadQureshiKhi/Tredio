import { type Change, diffHolding, type Holding, lossCapReached, mirror, openPnl } from "@tredio/autopilot";
import type { AccountState, HlNetwork } from "@tredio/hyperliquid";
import type { ExecutorDb, FollowRow, PositionRow } from "./db";
import type { Executor, TickContext } from "./executor";
import type { Log } from "./log";

/**
 * Copy-trading. Leaders are real Hyperliquid mainnet traders (testnet has no leaderboard) and the
 * Tredio bot, which trades on the trading network; a follower copies them into its own account on
 * the trading network (testnet while Tredio runs there). Each tick it first enforces loss caps,
 * then snapshots every followed leader's positions where the leader trades, diffs them against
 * the last snapshot (`leader_holdings`) and turns each change into an order for every follower
 * with `mirror()`, within the follow's own caps, its slippage from the mark (and from the leader's
 * fill when the leader trades on the trading network too) and the session's leverage cap. A
 * leader's first snapshot is only recorded: positions opened before anyone followed are not
 * copied. A copy whose leader has left the market is closed again on every tick until it is gone,
 * so a missed snapshot or a close that did not fill never leaves a follower holding the leader's
 * exit.
 */

/** Where leaders trade, and what they hold there. */
export interface LeaderSource {
  /** The network `leader` trades on, and its positions there. */
  state(leader: string): Promise<{ network: HlNetwork; state: AccountState }>;
  /** Marks by symbol on `network`, for the leverage a leader's position implies. */
  marks(network: HlNetwork): Promise<Map<string, number>>;
}

const money = (v: number) => `${v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)} USDC`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A leader's positions as copy-trading diffs them. */
export function holdingsOf(state: AccountState): Map<string, Holding> {
  return new Map(
    state.positions
      .filter((p) => p.szi !== 0 && Number.isFinite(p.szi))
      .map((p) => [p.coin, { side: p.szi > 0 ? ("long" as const) : ("short" as const), size: Math.abs(p.szi), marginUsdc: p.marginUsed, entryPrice: p.entryPx }]),
  );
}

const asHolding = (p: PositionRow): Holding => ({ side: p.side, size: p.size, marginUsdc: p.marginUsdc, entryPrice: p.entryPrice });

export class Copier {
  constructor(
    private readonly db: ExecutorDb,
    private readonly executor: Executor,
    private readonly leaders: LeaderSource,
    private readonly log: Log,
    /** The trading network, where copies execute. */
    private readonly network: HlNetwork,
  ) {}

  async tick(ctx: TickContext): Promise<void> {
    await this.guard(ctx).catch((e) => this.executor.fail("copy loss caps", e, {}));
    const follows = await this.db.activeFollows();
    if (follows.length === 0) return;
    const byLeader = new Map<string, FollowRow[]>();
    for (const f of follows) byLeader.set(f.leader, [...(byLeader.get(f.leader) ?? []), f]);
    for (const [leader, followers] of byLeader) {
      await this.copyLeader(leader, followers, ctx).catch((e) => this.executor.fail("leader snapshot", e, { leader }));
    }
  }

  private async copyLeader(leader: string, followers: FollowRow[], ctx: TickContext): Promise<void> {
    const { network, state } = await this.leaders.state(leader);
    const now = holdingsOf(state);
    // Only a leader on the trading network fills at prices a copy can be held to.
    const sameNetwork = network === this.network;
    const leaderMarks = await this.leaders.marks(network).catch(() => new Map<string, number>());
    const before = await this.db.leaderSnapshot(leader);
    const markets = [...new Set([...before.holdings.keys(), ...now.keys()])].sort();
    // The snapshot is stored before anything is copied: a crash mid-copy misses a change rather than copying it twice.
    // The first snapshot also records every market the followers could trade, so "seen" holds even for a flat leader.
    const rows = before.seen ? markets : [...new Set([...markets, ...ctx.bySymbol.keys()])];
    await this.db.saveLeaderHoldings(leader, rows.map((m) => ({ market: m, holding: now.get(m) ?? null })), ctx.nowSec);
    if (before.seen) {
      for (const m of markets) {
        const changes = diffHolding(m, before.holdings.get(m) ?? null, now.get(m) ?? null, leaderMarks.get(m) ?? ctx.mark(m) ?? 0);
        for (const change of changes) {
          await this.db.audit(leader, "leader_trade", { change });
          for (const f of followers) await this.copy(f, change, sameNetwork, ctx).catch((e) => this.executor.fail("copy", e, { follow: f.id }));
        }
      }
    }
    for (const f of followers) await this.sweep(f, now, ctx).catch((e) => this.executor.fail("copy sweep", e, { follow: f.id }));
  }

  private async skip(f: FollowRow, change: Change | { market: string }, reason: string): Promise<void> {
    await this.db.audit(f.follower, "copy_skipped", { change, reason }, null, f.id);
  }

  private async copy(f: FollowRow, change: Change, sameNetwork: boolean, ctx: TickContext): Promise<void> {
    const opening = change.kind === "open" || change.kind === "increase";
    if (opening && ctx.kill.engaged) return this.skip(f, change, `Autopilot is halted${ctx.kill.reason ? `: ${ctx.kill.reason}` : ""}`);
    const market = ctx.bySymbol.get(change.market);
    if (!market) return this.skip(f, change, `Hyperliquid ${this.network} does not list ${change.market}`);
    const resolved = await this.executor.venues.forOwner(f.follower, "session", ctx.nowSec);
    if (!("venue" in resolved)) return this.skip(f, change, resolved.reason);
    const venue = resolved.venue;
    const held = await this.db.livePosition({ followId: f.id, market: change.market });
    // An order is in flight for this copy; the executor settles it first.
    if (held && held.status !== "open") return this.skip(f, change, "an order for this copy is still in flight");
    const price = ctx.mark(change.market) ?? 0;
    const order = mirror(change, f.settings, held ? asHolding(held) : null, {
      price,
      sameNetwork,
      realizedTodayUsdc: await this.db.realizedToday({ followId: f.id }, ctx.nowSec),
      openPnlUsdc: openPnl(await this.db.followPositions(f.id), ctx.marks()),
      maxLeverage: Math.min(market.maxLeverage, venue.maxLeverage),
    });
    if (order.action === "skip") return this.skip(f, change, order.reason);
    const who = { owner: f.follower, ruleId: null, followId: f.id };
    if (order.action === "reduce") {
      const why = await this.executor.closePosition(venue, market, held!, ctx, { size: order.size, reason: change.kind === "close" ? "leader_close" : "leader_decrease", who });
      if (why) await this.skip(f, change, why);
      return;
    }
    if (!held) {
      const busy = await this.executor.marketBusy(f.follower, change.market, ctx);
      if (busy) return this.skip(f, change, busy);
    }
    const prepared = await this.executor.prepareOpen(venue, market, { side: order.side, size: order.size, marginUsdc: order.marginUsdc, leverage: order.leverage, worstPrice: order.worstPrice, existing: held ?? undefined }, ctx);
    if ("skip" in prepared) return this.skip(f, change, prepared.skip);
    const seq = (await this.db.followOrderCount(f.id)) + 1;
    await this.executor.placeOpen(
      venue,
      market,
      who,
      prepared,
      { intent: `follow:${f.id}:${change.market}:${seq}`, reason: `copied ${change.kind} of ${f.leader}`, signal: { leader: f.leader, change, worstPrice: prepared.worstPrice }, existing: held ?? undefined },
      ctx,
    );
  }

  /** Closes copies the leader no longer backs (it left the market or flipped), again each tick until they are gone. */
  private async sweep(f: FollowRow, leaderNow: Map<string, Holding>, ctx: TickContext): Promise<void> {
    const live = (await this.db.followPositions(f.id)).filter((p) => p.status === "open");
    if (live.length === 0) return;
    const orphans = live.filter((p) => leaderNow.get(p.market)?.side !== p.side);
    if (orphans.length === 0) return;
    const resolved = await this.executor.venues.forOwner(f.follower, "session", ctx.nowSec);
    if (!("venue" in resolved)) return;
    for (const p of orphans) {
      const market = ctx.bySymbol.get(p.market);
      if (!market) continue;
      await this.executor.closePosition(resolved.venue, market, p, ctx, { reason: "leader_exit", who: { owner: f.follower, ruleId: null, followId: f.id } });
    }
  }

  /**
   * Loss caps. A follow whose open copies are down its cap together is paused and closed out: each
   * open copy closes at the market, and closes that do not fill go out again on the next tick until
   * none is left. Closing out goes on through the kill switch, a pause or an unfollow, since it only
   * ever reduces risk.
   */
  private async guard(ctx: TickContext): Promise<void> {
    const marks = ctx.marks();
    for (const f of await this.db.followsToGuard()) {
      try {
        const live = await this.db.followPositions(f.id);
        if (!f.closingOut) {
          const pnl = openPnl(live, marks);
          if (!lossCapReached(f.settings, pnl)) continue;
          const reason = `Paused at your loss cap: open copies were down ${money(-pnl)} (cap ${money(f.settings.maxOpenLossUsdc)}), so Autopilot closed them.`;
          if (!(await this.db.startCloseOut(f.id, reason))) continue;
          await this.db.audit(f.follower, "copy_loss_cap", { leader: f.leader, openPnlUsdc: pnl, capUsdc: f.settings.maxOpenLossUsdc, positions: live.length }, null, f.id);
          this.log.warn({ follow: f.id, follower: f.follower, openPnlUsdc: pnl, capUsdc: f.settings.maxOpenLossUsdc }, "copy loss cap reached");
        }
        if (live.length === 0) {
          await this.db.endCloseOut(f.id);
          continue;
        }
        const resolved = await this.executor.venues.forOwner(f.follower, "session", ctx.nowSec);
        if (!("venue" in resolved)) continue;
        for (const p of live) {
          const market = ctx.bySymbol.get(p.market);
          // An order in flight is settled by the executor first.
          if (p.status !== "open" || !market) continue;
          await this.executor.closePosition(resolved.venue, market, p, ctx, { reason: "loss_cap", who: { owner: f.follower, ruleId: null, followId: f.id } });
        }
      } catch (e) {
        this.log.error({ follow: f.id, err: message(e) }, "copy loss cap check failed");
      }
    }
  }
}

type LeaderInfo = { accountState(user: string): Promise<AccountState>; perpMarkets(): Promise<Array<{ symbol: string; markPx: number }>> };

/**
 * Leaders through Hyperliquid's info API: those `onTradingNetwork` names (the Tredio bot) on the
 * trading network, everyone else on mainnet, whose leaderboard they come from. A leader is never
 * read on the wrong network, so `onTradingNetwork` failing fails the snapshot rather than guessing.
 */
export function hyperliquidLeaders(o: { network: HlNetwork; trading: LeaderInfo; mainnet: LeaderInfo; onTradingNetwork: (leader: string) => Promise<boolean> }): LeaderSource {
  const info = (network: HlNetwork) => (network === o.network ? o.trading : o.mainnet);
  return {
    state: async (leader) => {
      const network: HlNetwork = (await o.onTradingNetwork(leader)) ? o.network : "mainnet";
      return { network, state: await info(network).accountState(leader) };
    },
    marks: async (network) => new Map((await info(network).perpMarkets()).filter((m) => m.markPx > 0).map((m) => [m.symbol, m.markPx])),
  };
}
