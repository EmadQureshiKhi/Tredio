import type { Sender, Viewer } from "@tredio/chain";
import { type Calls, calls, type Deployment, type Market, type Order, type OrderSpec, type Placement, type Series, type Side, type Trend } from "@tredio/contracts";
import { findArbitrage, type Ladder, type Level, ladders, LOT, pickSeries, type QuoteParams, requoteUrgency, TOKEN } from "./strategy";

/**
 * The market maker's loop. Every tick it picks the series worth quoting (shorter windows first,
 * then by attention), keeps a complete-set inventory of each on the book, and re-quotes a side
 * when its resting orders drift from the ladder around the registry's fair value, all of a
 * side's cancels and placements in one `batch_update`. Post-only orders that would cross are
 * skipped by the book instead of failing the batch. Series that stop being quoted have their
 * orders pulled; settled ones are withdrawn and redeemed.
 */

export interface EngineConfig {
  windows: readonly number[];
  maxSeries: number;
  /** Complete sets minted per quoted series when its inventory runs low. */
  setsPerSeries: number;
  /** USDC kept on the book to back bids across all series. */
  marginUsdc: number;
  stopBeforeExpirySec: number;
  requoteTicks: number;
  minRequoteSec: number;
  arbMinEdge: number;
  arbMaxTokens: number;
  quote: QuoteParams;
}

export interface EngineState {
  /** Our resting order ids per market (`series:side`). */
  orders: Record<string, number[]>;
  /** Series we hold or held inventory in, until they are redeemed. */
  series: number[];
  /** Unix seconds of the last re-quote per market. */
  requotedAt: Record<string, number>;
  /**
   * The last ladder read per market and the market's trade count then: our orders can only change
   * when the market trades (or we re-quote), so an unchanged count keeps it instead of reading
   * every order again.
   */
  seen?: Record<string, { trades: number; ids: number[]; bids: Array<[number, string]>; asks: Array<[number, string]> }>;
}

export interface StateStore {
  load(): EngineState;
  save(s: EngineState): void;
}

const raw = (n: bigint | string) => BigInt(n);
const tokens = (n: bigint) => Number(n) / TOKEN;
const usdc = tokens;

export class Engine {
  private readonly C: Calls;
  private state: EngineState;
  lastTick: { at: number; quoted: number; requotes: number; arbitrages: number } | null = null;
  lastError: string | null = null;
  killed = false;
  equity: number | null = null;

  constructor(
    private readonly sender: Sender,
    private readonly viewer: Viewer,
    private readonly d: Deployment,
    private readonly cfg: EngineConfig,
    private readonly store: StateStore,
    private readonly log: (fields: Record<string, unknown>, msg: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.C = calls(d);
    this.state = store.load();
  }

  private get me() {
    return this.sender.accountId;
  }

  private view<T>(contract: string, method: string, args: object = {}) {
    return this.viewer.view<T>(contract, method, args);
  }

  private save() {
    this.store.save(this.state);
  }

  private async bookBalance(asset: "usdc" | { token: { series: number; side: Side } }): Promise<bigint> {
    return raw(await this.view<string>(this.d.contracts.book, "balance_of", { account_id: this.me, asset }));
  }

  /** Our live orders of a market as a ladder, with the ids still resting. */
  private async liveLadder(series: number, side: Side): Promise<{ ladder: Ladder; ids: number[] }> {
    const key = `${series}:${side}`;
    const market = await this.view<Market | null>(this.d.contracts.book, "get_market", { series, side });
    const seen = this.state.seen?.[key];
    if (seen && market && seen.trades === market.trades) {
      const level = ([tick, size]: [number, string]): Level => ({ tick, size: raw(size) });
      return { ladder: { bids: seen.bids.map(level), asks: seen.asks.map(level) }, ids: seen.ids };
    }
    const ids = this.state.orders[key] ?? [];
    const orders = (await Promise.all(ids.map((id) => this.view<Order | null>(this.d.contracts.book, "get_order", { order_id: id }).catch(() => null)))).filter((o): o is Order => o !== null);
    const bids = orders.filter((o) => o.dir === "buy").sort((a, b) => b.tick - a.tick);
    const asks = orders.filter((o) => o.dir === "sell").sort((a, b) => a.tick - b.tick);
    const level = (o: Order): Level => ({ tick: o.tick, size: raw(o.remaining) });
    if (market) {
      this.state.seen ??= {};
      this.state.seen[key] = { trades: market.trades, ids: orders.map((o) => o.id), bids: bids.map((o) => [o.tick, o.remaining]), asks: asks.map((o) => [o.tick, o.remaining]) };
    }
    return { ladder: { bids: bids.map(level), asks: asks.map(level) }, ids: orders.map((o) => o.id) };
  }

  private async quotable(nowSec: number): Promise<Array<{ series: Series; index: number }>> {
    const trends = await this.view<Trend[]>(this.d.contracts.registry, "get_trends", { from_index: 0, limit: 200 });
    const active = trends.filter((t) => t.status === "active");
    const latest = await Promise.all(
      active.flatMap((t) => this.cfg.windows.map(async (window) => ({ t, s: await this.view<Series | null>(this.d.contracts.outcomes, "latest_series", { trend: t.id, window }) }))),
    );
    const open = latest.filter((x): x is { t: Trend; s: Series } => x.s !== null && x.s.outcome === "open" && nowSec < x.s.expiry - this.cfg.stopBeforeExpirySec);
    const listed = await Promise.all(open.map(async (x) => ((await this.view<Market | null>(this.d.contracts.book, "get_market", { series: x.s.id, side: "up" })) ? x : null)));
    const candidates = listed.filter((x): x is { t: Trend; s: Series } => x !== null).map((x) => ({ series: x.s, index: x.t.index, window: x.s.window }));
    return pickSeries(candidates, this.cfg.maxSeries);
  }

  /** Keeps `sets` complete sets of a series on the book, minting from wallet USDC when low. */
  private async ensureInventory(s: Series, held: { up: bigint; down: bigint }): Promise<{ up: bigint; down: bigint }> {
    const want = BigInt(Math.floor(this.cfg.setsPerSeries * TOKEN));
    if (held.up >= want / 2n && held.down >= want / 2n) return held;
    const wallet = raw(await this.view<string>(this.d.contracts.usdc, "ft_balance_of", { account_id: this.me }));
    const amount = ((wallet < want ? wallet : want) / LOT) * LOT;
    if (amount < LOT * 1000n) return held;
    await this.sender.send(this.C.outcomes.mint(s.id, amount.toString()));
    await Promise.all((["up", "down"] as const).map((side) => this.sender.send(this.C.outcomes.toBook(s.id, side, amount.toString()))));
    if (!this.state.series.includes(s.id)) this.state.series.push(s.id);
    this.save();
    this.log({ series: s.id, sets: tokens(amount) }, "minted inventory");
    return { up: held.up + amount, down: held.down + amount };
  }

  /** Keeps MARGIN_USDC on the book for bids. */
  private async ensureMargin(): Promise<bigint> {
    const onBook = await this.bookBalance("usdc");
    const target = BigInt(Math.floor(this.cfg.marginUsdc * TOKEN));
    if (onBook >= target / 2n) return onBook;
    const wallet = raw(await this.view<string>(this.d.contracts.usdc, "ft_balance_of", { account_id: this.me }));
    const amount = ((target - onBook < wallet ? target - onBook : wallet) / LOT) * LOT;
    if (amount <= 0n) return onBook;
    await this.sender.send(this.C.book.depositUsdc(amount.toString()));
    return onBook + amount;
  }

  private specs(series: number, side: Side, l: Ladder): OrderSpec[] {
    return [
      ...l.bids.map((b) => ({ series, side, dir: "buy" as const, tick: b.tick, size: b.size.toString(), tif: "post_only" as const })),
      ...l.asks.map((a) => ({ series, side, dir: "sell" as const, tick: a.tick, size: a.size.toString(), tif: "post_only" as const })),
    ];
  }

  private async requote(key: string, cancels: number[], places: OrderSpec[], nowSec: number) {
    const r = await this.sender.send<Placement[]>(this.C.book.batchUpdate(cancels, places));
    this.state.orders[key] = (r.value ?? []).flatMap((p) => (p.order_id !== null ? [p.order_id] : []));
    this.state.requotedAt[key] = nowSec;
    // The new orders are read once on the next tick.
    if (this.state.seen) delete this.state.seen[key];
    this.save();
  }

  /** Pulls every order we have resting. */
  async cancelAll(): Promise<void> {
    for (const [key, ids] of Object.entries(this.state.orders)) {
      if (ids.length === 0) continue;
      await this.sender.send(this.C.book.batchUpdate(ids, [])).catch((e: Error) => this.log({ key, err: e.message }, "cancel failed"));
      this.state.orders[key] = [];
      if (this.state.seen) delete this.state.seen[key];
      this.save();
    }
  }

  /** Withdraws and redeems the inventory of settled series. */
  private async redeemSettled(): Promise<void> {
    for (const id of [...this.state.series]) {
      const s = await this.view<Series | null>(this.d.contracts.outcomes, "get_series", { series: id });
      if (!s || s.outcome === "open") continue;
      for (const side of ["up", "down"] as const) {
        const key = `${id}:${side}`;
        if ((this.state.orders[key] ?? []).length > 0) await this.sender.send(this.C.book.batchUpdate(this.state.orders[key]!, [])).catch(() => undefined);
        this.state.orders[key] = [];
        if (this.state.seen) delete this.state.seen[key];
        const onBook = await this.bookBalance({ token: { series: id, side } });
        if (onBook > 0n) await this.sender.send(this.C.book.withdraw({ token: { series: id, side } }, onBook.toString()));
      }
      const wallet = (side: Side) => this.view<string>(this.d.contracts.outcomes, "mt_balance_of", { account_id: this.me, token_id: `${id}:${side}` }).then(raw);
      const [up, down] = [await wallet("up"), await wallet("down")];
      if (up > 0n || down > 0n) await this.sender.send(this.C.outcomes.redeemWinnings(id, up.toString(), down.toString()));
      this.state.series = this.state.series.filter((x) => x !== id);
      this.save();
      this.log({ series: id, outcome: s.outcome, up: tokens(up), down: tokens(down) }, "redeemed settled series");
    }
  }

  /** Takes a complete-set arbitrage against other traders' best orders, if one clears the edge. */
  private async arbitrage(s: Series): Promise<boolean> {
    const best = async (side: Side) => {
      const depth = await this.view<{ bids: Array<{ tick: number; size: string }>; asks: Array<{ tick: number; size: string }> }>(this.d.contracts.book, "depth", { series: s.id, side, levels: 1 });
      const lvl = (x?: { tick: number; size: string }) => (x ? { tick: x.tick, size: raw(x.size) } : null);
      return { bestBid: lvl(depth.bids[0]), bestAsk: lvl(depth.asks[0]) };
    };
    const [up, down] = await Promise.all([best("up"), best("down")]);
    const fee = await this.view<number>(this.d.contracts.book, "taker_fee_bps");
    const a = findArbitrage(up, down, fee, this.cfg.arbMinEdge, this.cfg.arbMaxTokens);
    if (!a) return false;
    const size = ((BigInt(Math.floor(a.tokens * TOKEN)) / LOT) * LOT).toString();
    if (a.kind === "buyBoth") {
      for (const [side, tick] of [["up", a.upTick], ["down", a.downTick]] as const) {
        const cost = ((BigInt(size) * BigInt(tick)) / 1000n).toString();
        await this.sender.send(this.C.book.depositUsdc(cost, JSON.stringify({ swap: { series: s.id, side, limit_tick: tick, min_out: "0", anchored: false } })));
      }
    } else {
      await this.sender.send(this.C.outcomes.mint(s.id, size));
      for (const [side, tick] of [["up", a.upTick], ["down", a.downTick]] as const) {
        await this.sender.send(this.C.outcomes.toBook(s.id, side, size, JSON.stringify({ swap: { series: s.id, side, limit_tick: tick, min_out: "0", anchored: false } })));
      }
    }
    this.log({ series: s.id, kind: a.kind, tokens: a.tokens, edge: a.edge }, "arbitrage");
    return true;
  }

  async tick(killed: boolean): Promise<void> {
    const nowSec = Math.floor(this.now() / 1000);
    this.killed = killed;
    if (killed) {
      await this.cancelAll();
      this.lastTick = { at: nowSec, quoted: 0, requotes: 0, arbitrages: 0 };
      return;
    }
    await this.redeemSettled();
    const picked = await this.quotable(nowSec);
    const pickedIds = new Set(picked.map((p) => p.series.id));
    // Pull orders from series we no longer quote (near expiry, cooled, or crowded out).
    for (const [key, ids] of Object.entries(this.state.orders)) {
      const id = Number(key.split(":")[0]);
      if (!pickedIds.has(id) && ids.length > 0) await this.requote(key, ids, [], nowSec);
    }
    const margin = await this.ensureMargin();
    let requotes = 0;
    let arbitrages = 0;
    let equity = usdc(margin) + usdc(raw(await this.view<string>(this.d.contracts.usdc, "ft_balance_of", { account_id: this.me })));
    for (const { series: s } of picked) {
      const fair = Number(await this.view<string>(this.d.contracts.registry, "fair_up", { id: s.trend, opening: s.opening_index, expiry: s.expiry })) / TOKEN;
      const live = { up: await this.liveLadder(s.id, "up"), down: await this.liveLadder(s.id, "down") };
      const restingAsks = (l: Ladder) => l.asks.reduce((a, x) => a + x.size, 0n);
      const restingBids = (l: Ladder) => l.bids.reduce((a, x) => a + (x.size * BigInt(x.tick)) / 1000n, 0n);
      let held = {
        up: (await this.bookBalance({ token: { series: s.id, side: "up" } })) + restingAsks(live.up.ladder),
        down: (await this.bookBalance({ token: { series: s.id, side: "down" } })) + restingAsks(live.down.ladder),
      };
      held = await this.ensureInventory(s, held);
      const bidBudget = usdc(margin + restingBids(live.up.ladder) + restingBids(live.down.ladder)) / Math.max(1, picked.length);
      const want = ladders(fair, { up: tokens(held.up), down: tokens(held.down), usdc: bidBudget }, this.cfg.quote);
      equity += tokens(held.up) * fair + tokens(held.down) * (1 - fair);
      if (await this.arbitrage(s).catch(() => false)) arbitrages++;
      for (const side of ["up", "down"] as const) {
        const key = `${s.id}:${side}`;
        const urgency = requoteUrgency(live[side].ladder, want[side], this.cfg.requoteTicks);
        const since = nowSec - (this.state.requotedAt[key] ?? 0);
        if (urgency === "urgent" || (urgency === "drift" && since >= this.cfg.minRequoteSec)) {
          await this.requote(key, live[side].ids, this.specs(s.id, side, want[side]), nowSec);
          requotes++;
        }
      }
      if (!this.state.series.includes(s.id)) this.state.series.push(s.id);
    }
    this.save();
    this.equity = equity;
    this.lastTick = { at: nowSec, quoted: picked.length, requotes, arbitrages };
    this.lastError = null;
    if (requotes > 0 || arbitrages > 0) this.log({ quoted: picked.length, requotes, arbitrages }, "tick");
  }
}
