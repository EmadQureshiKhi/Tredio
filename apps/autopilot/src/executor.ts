import { evaluate, grossPnlUsdc, type RuleState, type Side } from "@tredio/autopilot";
import type { AccountVersion } from "@tredio/contracts";
import type { AccountState, PerpMarket } from "@tredio/hyperliquid";
import type { ExecutorDb, OrderResult, OrderRow, PositionRow, RuleRow } from "./db";
import type { Log } from "./log";
import { buildOrder, guardProblem, isBuy, MIN_ORDER_USD, openingLeverage, type RegistryMark, sizeAtLeverage, worstPrice } from "./orders";
import type { Resolved } from "./venues";
import { type Fill, type Nonces, type SendResult, type Venue, VenueError } from "./venue";

/**
 * The Autopilot loop. Each tick it finishes orders left in flight, reconciles recorded positions
 * with what Hyperliquid holds, evaluates every running rule with the shared engine and acts, then
 * lets copy-trading mirror leaders. An order is recorded (with a unique intent and its Hyperliquid
 * nonce) before anything is sent, so a retry is the same order and Hyperliquid runs it at most
 * once; every decision, order and failure lands in the audit log.
 */

export interface VenueResolver {
  refresh(nowSec: number): Promise<void>;
  forOwner(owner: string, route?: "api" | "session", nowSec?: number): Promise<Resolved>;
}

/** Hyperliquid reads for any account, granted or not: reconciliation needs no session. */
export interface AccountReader {
  addressOf(owner: string): Promise<string>;
  state(address: string): Promise<AccountState>;
  fills(address: string): Promise<Fill[]>;
}

export interface ExecutorOptions {
  /** Worst fill accepted, basis points from the mark (at most 1%: the account's guard allows 2% from a mark up to two minutes old, five on v2 account code). */
  slippageBps: number;
  /** Pause a rule after this many failed orders in a row. */
  maxConsecutiveFailures: number;
  /** Give up on an order after this many attempts that failed before Hyperliquid answered. */
  maxAttempts: number;
  /** An order still in flight after this long is settled from the account's fills instead of being sent again. */
  orderStaleSec: number;
  /** Kill switch from the environment, on top of the admin switch. */
  killEnv: boolean;
  /** How old a Nansen reading may be and still count. */
  netflowMaxAgeSec: number;
  /** Fee charged per fill when Hyperliquid's fills do not show it yet, basis points of notional. */
  takerFeeBps: number;
}

export interface ExecutorStatus {
  lastTickAt: number | null;
  lastTickMs: number;
  lastError: string | null;
  /** Ticks in a row that failed as a whole. */
  failingTicks: number;
  kill: { engaged: boolean; reason: string | null };
  rules: number;
  ticks: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const money = (v: number) => `${v.toFixed(2)} USDC`;

/** What one tick knows: the time, the kill switch, markets with their marks, and reads shared across rules and copies. */
export class TickContext {
  private readonly registry = new Map<string, Promise<{ mark: RegistryMark | null } | { error: string }>>();
  private readonly states = new Map<string, Promise<AccountState>>();
  private readonly fillsBy = new Map<string, Promise<Fill[]>>();

  constructor(
    readonly nowSec: number,
    readonly kill: { engaged: boolean; reason: string | null },
    readonly bySymbol: ReadonlyMap<string, PerpMarket>,
    private readonly readMark: (asset: string) => Promise<RegistryMark | null>,
    private readonly reader: AccountReader,
  ) {}

  /** The trading network's mark price, or null. */
  mark(symbol: string): number | null {
    const p = this.bySymbol.get(symbol)?.markPx;
    return p !== undefined && Number.isFinite(p) && p > 0 ? p : null;
  }

  marks(): Map<string, number> {
    return new Map([...this.bySymbol.values()].flatMap((m) => (this.mark(m.symbol) ? [[m.symbol, m.markPx] as [string, number]] : [])));
  }

  /** Why the account's order guard (of the account's code `version`) would refuse an order at `price` on `assetIndex` now, or null. */
  async guard(asset: string, price: string, order: { assetIndex: number; version: AccountVersion }): Promise<string | null> {
    let read = this.registry.get(asset);
    if (!read) {
      read = this.readMark(asset).then(
        (mark) => ({ mark }),
        (e: unknown) => ({ error: message(e) }),
      );
      this.registry.set(asset, read);
    }
    const r = await read;
    return "error" in r ? `could not read Tredio's ${asset} mark: ${r.error}` : guardProblem(asset, price, r.mark, this.nowSec, order);
  }

  async state(owner: string): Promise<AccountState> {
    let s = this.states.get(owner);
    if (!s) {
      s = this.reader.addressOf(owner).then((a) => this.reader.state(a));
      this.states.set(owner, s);
      s.catch(() => this.states.delete(owner));
    }
    return s;
  }

  async fills(owner: string): Promise<Fill[]> {
    let f = this.fillsBy.get(owner);
    if (!f) {
      f = this.reader.addressOf(owner).then((a) => this.reader.fills(a));
      this.fillsBy.set(owner, f);
      f.catch(() => this.fillsBy.delete(owner));
    }
    return f;
  }

  /** An order filled for `owner`: later reads this tick must see it. */
  changed(owner: string): void {
    this.states.delete(owner);
    this.fillsBy.delete(owner);
  }
}

/** An opening ready to record: the order the contract signs and what it commits. */
export interface PreparedOpen {
  side: Side;
  /** Whole-number leverage the position trades at. */
  leverage: number;
  /** Set this leverage on Hyperliquid first (a new position); null when adding to one. */
  setLeverage: number | null;
  size: number;
  worstPrice: number;
  marginUsdc: number;
}

export interface OpenRequest {
  side: Side;
  size: number;
  marginUsdc: number;
  leverage: number;
  /** A tighter worst price than the slippage from the mark (a copy's limit from the leader's fill). */
  worstPrice?: number;
  /** Adding to this position instead of opening one. */
  existing?: PositionRow;
}

export interface Who {
  owner: string;
  ruleId: number | null;
  followId: number | null;
}

export class Executor {
  readonly status: ExecutorStatus = { lastTickAt: null, lastTickMs: 0, lastError: null, failingTicks: 0, kill: { engaged: false, reason: null }, rules: 0, ticks: 0 };
  /** The last reason each rule waited, so the audit log records changes rather than every tick. */
  private readonly lastWait = new Map<number, string>();
  private tickErrors: string[] = [];

  constructor(
    readonly db: ExecutorDb,
    private readonly markets: () => Promise<PerpMarket[]>,
    private readonly registryMark: (asset: string) => Promise<RegistryMark | null>,
    readonly venues: VenueResolver,
    private readonly reader: AccountReader,
    private readonly nonces: Nonces,
    private readonly opts: ExecutorOptions,
    private readonly log: Log,
    private readonly afterRules?: (ctx: TickContext) => Promise<void>,
  ) {}

  async tick(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
    const started = Date.now();
    this.tickErrors = [];
    try {
      const switched = await this.db.killSwitch();
      const kill = this.opts.killEnv ? { engaged: true, reason: switched.engaged ? switched.reason : "KILL_SWITCH is set on the executor" } : switched;
      const bySymbol = new Map((await this.markets()).map((m) => [m.symbol, m]));
      const ctx = new TickContext(nowSec, kill, bySymbol, this.registryMark, this.reader);
      this.status.kill = kill;

      await this.venues.refresh(nowSec);
      for (const o of await this.db.openOrders()) await this.resolve(o, ctx).catch((e) => this.fail("resolve", e, { order: o.id }));
      await this.reconcile(ctx).catch((e) => this.fail("reconcile", e, {}));
      const rules = await this.db.rulesToRun();
      for (const r of rules) await this.runRule(r, ctx).catch((e) => this.fail("rule", e, { rule: r.id }));
      if (this.afterRules) await this.afterRules(ctx).catch((e) => this.fail("copy", e, {}));

      this.status.rules = rules.length;
      this.status.lastError = this.tickErrors[0] ?? null;
      this.status.failingTicks = 0;
    } catch (e) {
      this.status.lastError = message(e);
      this.status.failingTicks++;
      throw e;
    } finally {
      this.status.lastTickAt = nowSec;
      this.status.lastTickMs = Date.now() - started;
      this.status.ticks++;
    }
  }

  fail(where: string, e: unknown, fields: Record<string, unknown>): void {
    const m = `${where}: ${message(e).slice(0, 300)}`;
    this.tickErrors.push(m);
    this.log.error({ ...fields, err: m }, `autopilot ${where} failed`);
  }

  // Rules ---------------------------------------------------------------------------------------

  private async runRule(r: RuleRow, ctx: TickContext): Promise<void> {
    const market = ctx.bySymbol.get(r.rule.market);
    if (!market) return this.halt(r, `Hyperliquid has no ${r.rule.market} perp on this network`, true);
    const resolved = await this.venues.forOwner(r.owner, r.route, ctx.nowSec);
    if (!("venue" in resolved)) return this.halt(r, resolved.reason, resolved.pause);
    const venue = resolved.venue;
    const pos = await this.db.livePosition({ ruleId: r.id });
    // An order is in flight for it; resolve() settles it first.
    if (pos && pos.status !== "open") return;
    // Paused and stopped rules only manage the position they hold.
    if (!pos && r.status !== "enabled") return;
    const price = ctx.mark(market.symbol);
    if (!price) return this.wait(r, `no ${market.symbol} mark price`);

    const trendId = await this.db.trendIdOf(r.rule.trend);
    const attention = trendId ? await this.db.attention(trendId, ctx.nowSec, r.rule.entry.windowMin * 60) : [];
    const netflow = await this.db.latestNetflow(r.rule.trend, ctx.nowSec, this.opts.netflowMaxAgeSec);
    const state: RuleState = {
      position:
        pos && pos.entryPrice !== null && pos.openedAt !== null
          ? { side: pos.side, entryPrice: pos.entryPrice, size: pos.size, marginUsdc: pos.marginUsdc, leverage: pos.leverage, openedAt: pos.openedAt }
          : null,
      realizedTodayUsdc: await this.db.realizedToday({ ruleId: r.id }, ctx.nowSec),
      lastExitAt: await this.db.lastExitAt(r.id),
      // The owner's stop and the kill switch close the position now (the engine's `kill` exit);
      // a pause manages it to its exit. Openings below wait while the kill switch is engaged.
      killed: r.status === "stopped" || ctx.kill.engaged,
    };
    if (ctx.kill.engaged && !state.position) return this.wait(r, `Autopilot is halted${ctx.kill.reason ? `: ${ctx.kill.reason}` : ""}`);
    const d = evaluate(r.rule, state, { now: ctx.nowSec, price, attention, netflowUsd: netflow });
    if (d.action === "wait") return this.wait(r, d.reason);
    if (d.action === "hold") return this.wait(r, "holding the position until an exit");

    if (d.action === "close") {
      if (!pos) return;
      const busy = await this.closePosition(venue, market, pos, ctx, { reason: d.reason, who: { owner: r.owner, ruleId: r.id, followId: null }, signal: { reason: d.reason, movePct: d.movePct, price } });
      if (busy) return this.wait(r, `exit signal (${d.reason}), but ${busy}`);
      this.lastWait.delete(r.id);
      return;
    }

    if (r.status !== "enabled") return;
    if (ctx.kill.engaged) return this.wait(r, `Autopilot is halted${ctx.kill.reason ? `: ${ctx.kill.reason}` : ""}`);
    const busy = await this.marketBusy(r.owner, market.symbol, ctx);
    if (busy) return this.wait(r, busy);
    const prepared = await this.prepareOpen(venue, market, { side: d.side, size: d.size, marginUsdc: d.marginUsdc, leverage: d.leverage }, ctx);
    if ("skip" in prepared) return this.wait(r, `entry signal (${d.reason}), but ${prepared.skip}`);
    this.lastWait.delete(r.id);
    await this.db.audit(r.owner, "entry_signal", { reason: d.reason, signal: d.signal, price, size: prepared.size, marginUsdc: prepared.marginUsdc, leverage: prepared.leverage }, r.id);
    const n = (await this.db.positionCount(r.id)) + 1;
    await this.placeOpen(venue, market, { owner: r.owner, ruleId: r.id, followId: null }, prepared, { intent: `rule:${r.id}:open:${n}`, reason: d.reason, signal: { ...d.signal, price } }, ctx);
  }

  private async wait(r: RuleRow, reason: string): Promise<void> {
    if (this.lastWait.get(r.id) === reason) return;
    this.lastWait.set(r.id, reason);
    await this.db.audit(r.owner, "waiting", { reason }, r.id);
  }

  /** A rule that cannot run: paused when the account must act (no grant, no market), otherwise it waits. */
  private async halt(r: RuleRow, reason: string, pause: boolean): Promise<void> {
    if (!pause || r.status !== "enabled") return this.wait(r, reason);
    if (await this.db.pauseRule(r.id, reason)) {
      await this.db.audit(r.owner, "rule_paused", { reason, by: "autopilot" }, r.id);
      this.log.warn({ rule: r.id, reason }, "rule paused");
    }
  }

  /** Why the owner cannot open in `symbol` now (it already trades it: a rule, a copy or a manual position), or null. */
  async marketBusy(owner: string, symbol: string, ctx: TickContext): Promise<string | null> {
    const live = await this.db.liveInMarket(owner, symbol);
    if (live.length > 0) return `${symbol} already has an Autopilot position on this account (${live[0]!.ruleId !== null ? `rule ${live[0]!.ruleId}` : `copy ${live[0]!.followId}`})`;
    const state = await ctx.state(owner).catch(() => null);
    if (state?.positions.some((p) => p.coin === symbol && p.szi !== 0)) return `the account already holds ${symbol} on Hyperliquid`;
    return null;
  }

  // Orders --------------------------------------------------------------------------------------

  /**
   * Turns an opening into the order the account will sign, or says why it cannot go out now: at
   * a whole-number leverage within the market's and the session's caps (a lower leverage keeps the
   * margin and shrinks the size), above Hyperliquid's minimum, inside the account's price guard,
   * and with the margin available on Hyperliquid.
   */
  async prepareOpen(venue: Venue, market: PerpMarket, req: OpenRequest, ctx: TickContext): Promise<PreparedOpen | { skip: string }> {
    const mark = ctx.mark(market.symbol);
    if (!mark) return { skip: `no ${market.symbol} mark price` };
    const leverage = req.existing ? Math.max(1, Math.round(req.existing.leverage)) : openingLeverage(req.leverage, market.maxLeverage, venue.maxLeverage);
    const size = sizeAtLeverage(req.size, req.leverage, leverage);
    const buy = req.side === "long";
    const order = buildOrder(market, { buy, worstPrice: worstPrice(buy, mark, this.opts.slippageBps, req.worstPrice), size, reduceOnly: false });
    if ("skip" in order) return order;
    const notional = Number(order.size) * mark;
    if (notional < MIN_ORDER_USD) return { skip: `a ${money(notional)} order is below Hyperliquid's ${MIN_ORDER_USD} USDC minimum` };
    const guard = await ctx.guard(market.symbol, order.price, { assetIndex: order.asset_index, version: await venue.version() });
    if (guard) return { skip: guard };
    const marginUsdc = notional / leverage;
    const state = await ctx.state(venue.owner).catch(() => null);
    const needed = marginUsdc + (notional * this.opts.takerFeeBps) / 10_000;
    if (state && state.withdrawable < needed) return { skip: `the account's Hyperliquid balance (${money(state.withdrawable)} available) is below the ${money(needed)} this opening needs` };
    return { side: req.side, leverage, setLeverage: req.existing ? null : leverage, size: Number(order.size), worstPrice: Number(order.price), marginUsdc };
  }

  /** Records a prepared opening (and its position) and sends it. */
  async placeOpen(venue: Venue, market: PerpMarket, who: Who, p: PreparedOpen, o: { intent: string; reason: string; signal: Record<string, unknown>; existing?: PositionRow }, ctx: TickContext): Promise<void> {
    const { order, created } = await this.db.startOrder({
      intent: o.intent,
      owner: who.owner,
      market: market.symbol,
      action: "open",
      side: p.side,
      size: p.size,
      worstPrice: p.worstPrice,
      leverage: p.leverage,
      nonce: this.nonces.next(),
      reason: o.reason,
      at: ctx.nowSec,
      position: o.existing ? { existingId: o.existing.id } : { ruleId: who.ruleId, followId: who.followId, signal: o.signal },
    });
    if (created) await this.submit(order, venue, market, ctx, { setLeverage: p.setLeverage, who });
  }

  /**
   * Closes a live position, or reduces it by `size`, at the worst price the slippage allows from
   * the mark. Returns why it cannot go out now (the order guard waits for a fresh mark), or null.
   */
  async closePosition(venue: Venue, market: PerpMarket, p: PositionRow, ctx: TickContext, o: { size?: number; reason: string; who: Who; signal?: Record<string, unknown> }): Promise<string | null> {
    const mark = ctx.mark(market.symbol);
    if (!mark) return `no ${market.symbol} mark price`;
    const size = Math.min(o.size ?? p.size, p.size);
    const action = size < p.size * (1 - 1e-6) ? "reduce" : "close";
    const buy = isBuy(action, p.side);
    const order = buildOrder(market, { buy, worstPrice: worstPrice(buy, mark, this.opts.slippageBps), size, reduceOnly: true });
    if ("skip" in order) return order.skip;
    const guard = await ctx.guard(market.symbol, order.price, { assetIndex: order.asset_index, version: await venue.version() });
    if (guard) return guard;
    if (o.signal) await this.db.audit(o.who.owner, "exit_signal", o.signal, o.who.ruleId, o.who.followId);
    const n = await this.db.orderCount(p.id);
    const { order: row, created } = await this.db.startOrder({
      intent: `position:${p.id}:${action}:${n + 1}`,
      owner: o.who.owner,
      market: market.symbol,
      action,
      side: p.side,
      size: Number(order.size),
      worstPrice: Number(order.price),
      leverage: p.leverage,
      nonce: this.nonces.next(),
      reason: o.reason,
      at: ctx.nowSec,
      position: { existingId: p.id },
    });
    if (created) await this.submit(row, venue, market, ctx, { setLeverage: null, who: o.who });
    return null;
  }

  /** Sends a recorded order and records how it ended (or that it stays in flight for a retry). */
  private async submit(o: OrderRow, venue: Venue, market: PerpMarket, ctx: TickContext, x: { setLeverage: number | null; who: Who }): Promise<void> {
    const order = buildOrder(market, { buy: isBuy(o.action, o.side), worstPrice: o.worstPrice, size: o.size, reduceOnly: o.action !== "open" });
    if ("skip" in order) return this.finish(o, { status: "failed", error: order.skip }, ctx, x.who);
    let res: SendResult;
    try {
      res = await venue.send({ market, action: o.action, side: o.side, order, leverage: x.setLeverage, nonce: o.nonce }, async (hash) => {
        await this.db.orderSent(o.id, hash);
        await this.db.audit(o.owner, "order_sent", { orderId: o.id, action: o.action, side: o.side, market: o.market, size: order.size, price: order.price, nonce: o.nonce, tx: hash, venue: venue.kind }, x.who.ruleId, x.who.followId);
      });
    } catch (e) {
      if (e instanceof VenueError && e.retryable) {
        const attempts = await this.db.orderRetry(o.id, e.message);
        await this.db.audit(o.owner, "order_retry", { orderId: o.id, attempts, error: e.message }, x.who.ruleId, x.who.followId);
        if (attempts >= this.opts.maxAttempts) await this.finish(o, { status: "failed", error: `gave up after ${attempts} attempts: ${e.message}` }, ctx, x.who);
        return;
      }
      return this.finish(o, { status: "failed", error: message(e) }, ctx, x.who);
    }
    if (res.status === "seen") return this.settleFromFills(o, market, ctx, x.who, `Hyperliquid had already seen this order (${res.error})`);
    if (res.status !== "filled") return this.finish(o, { status: res.status, txHash: res.txHash, error: res.error }, ctx, x.who);
    ctx.changed(o.owner);
    await this.finish(o, await this.filled(o, { size: res.size, price: res.price, feeUsdc: res.feeUsdc, closedPnlUsdc: res.closedPnlUsdc, txHash: res.txHash, oid: res.oid }), ctx, x.who);
  }

  /** A fill as the order's result: an opening's margin, a close's PnL (Hyperliquid's own, else from the entry). */
  private async filled(o: OrderRow, f: { size: number; price: number; feeUsdc: number | null; closedPnlUsdc: number | null; txHash: string | null; oid: number | null }): Promise<OrderResult & { oid: number | null }> {
    const feeUsdc = f.feeUsdc ?? (f.size * f.price * this.opts.takerFeeBps) / 10_000;
    const base = { status: "filled" as const, txHash: f.txHash, fillPrice: f.price, fillSize: f.size, feeUsdc, oid: f.oid };
    if (o.action === "open") return { ...base, marginUsdc: (f.size * f.price) / Math.max(1, o.leverage) };
    const p = o.positionId !== null ? await this.db.position(o.positionId) : null;
    const pnlUsdc = f.closedPnlUsdc ?? (p?.entryPrice ? grossPnlUsdc({ side: p.side, entryPrice: p.entryPrice, size: f.size }, f.price) : 0);
    return { ...base, pnlUsdc };
  }

  private async finish(o: OrderRow, r: OrderResult & { oid?: number | null }, ctx: TickContext, who: Who): Promise<void> {
    await this.db.orderDone(o, { ...r, closeReason: o.reason ?? undefined, at: ctx.nowSec });
    await this.db.audit(
      o.owner,
      `order_${r.status}`,
      { orderId: o.id, action: o.action, side: o.side, market: o.market, price: r.fillPrice ?? null, size: r.fillSize ?? null, feeUsdc: r.feeUsdc ?? null, pnlUsdc: r.pnlUsdc ?? null, tx: r.txHash ?? o.txHash, oid: r.oid ?? null, error: r.error ?? null },
      who.ruleId,
      who.followId,
    );
    this.log.info({ order: o.id, intent: o.intent, status: r.status, price: r.fillPrice, size: r.fillSize, error: r.error }, "order finished");
    if (r.status === "failed" && who.ruleId !== null && (await this.db.consecutiveFailures(who.ruleId)) >= this.opts.maxConsecutiveFailures) {
      const reason = `${this.opts.maxConsecutiveFailures} orders failed in a row: ${r.error ?? "unknown"}`;
      if (await this.db.pauseRule(who.ruleId, reason)) await this.db.audit(o.owner, "rule_paused", { reason, by: "autopilot" }, who.ruleId);
    }
  }

  /**
   * Settles an order from the account's fills: the ones on its market and side since it was
   * recorded, when Hyperliquid has seen its nonce before or it has been in flight too long to send
   * again.
   */
  private async settleFromFills(o: OrderRow, market: PerpMarket, ctx: TickContext, who: Who, why: string): Promise<void> {
    const fills = await ctx.fills(o.owner);
    const side = isBuy(o.action, o.side) ? "B" : "A";
    const from = (o.createdAt - 5) * 1000;
    const to = (o.createdAt + this.opts.orderStaleSec + 60) * 1000;
    const mine = fills.filter((f) => f.coin === market.symbol && f.side === side && f.time >= from && f.time <= to);
    const size = Math.min(o.size, mine.reduce((a, f) => a + f.sz, 0));
    if (size <= 0) return this.finish(o, { status: "unfilled", error: `${why}; no fill on Hyperliquid` }, ctx, who);
    const price = mine.reduce((a, f) => a + f.px * f.sz, 0) / mine.reduce((a, f) => a + f.sz, 0);
    ctx.changed(o.owner);
    await this.finish(o, await this.filled(o, { size, price, feeUsdc: mine.reduce((a, f) => a + f.fee, 0), closedPnlUsdc: o.action === "open" ? null : mine.reduce((a, f) => a + f.closedPnl, 0), txHash: o.txHash, oid: mine[0]?.oid ?? null }), ctx, who);
  }

  /** Finishes orders left in flight by an earlier tick: sends them again with the same nonce, or settles them once too old. */
  private async resolve(o: OrderRow, ctx: TickContext): Promise<void> {
    const p = o.positionId !== null ? await this.db.position(o.positionId) : null;
    const who: Who = { owner: o.owner, ruleId: p?.ruleId ?? null, followId: p?.followId ?? null };
    const market = ctx.bySymbol.get(o.market);
    if (!market) return this.finish(o, { status: "failed", error: `Hyperliquid no longer lists ${o.market}` }, ctx, who);
    if (ctx.nowSec - o.createdAt > this.opts.orderStaleSec) return this.settleFromFills(o, market, ctx, who, "in flight too long to send again");
    const resolved = await this.venues.forOwner(o.owner, "session", ctx.nowSec);
    if (!("venue" in resolved)) {
      // Signed already: Hyperliquid may have run it, which the account's fills tell without a session.
      if (o.status === "sent") return this.settleFromFills(o, market, ctx, who, resolved.reason);
      return this.finish(o, { status: "failed", error: resolved.reason }, ctx, who);
    }
    // A new position sets its leverage first; adding to one keeps the leverage it has.
    const setLeverage = o.action === "open" && (p?.size ?? 0) === 0 ? o.leverage : null;
    return this.submit(o, resolved.venue, market, ctx, { setLeverage, who });
  }

  // Reconciliation ------------------------------------------------------------------------------

  /** Positions Hyperliquid closed or shrank without an order of ours: liquidations and manual trades. */
  private async reconcile(ctx: TickContext): Promise<void> {
    const byOwner = new Map<string, PositionRow[]>();
    for (const p of await this.db.openPositions()) byOwner.set(p.owner, [...(byOwner.get(p.owner) ?? []), p]);
    for (const [owner, positions] of byOwner) {
      // One owner's failure (an RPC error, Hyperliquid unavailable) leaves the others reconciled.
      await this.reconcileOwner(owner, positions, ctx).catch((e) => this.fail("reconcile", e, { owner }));
    }
  }

  private async reconcileOwner(owner: string, positions: PositionRow[], ctx: TickContext): Promise<void> {
    const state = await ctx.state(owner);
    const held = new Map(state.positions.filter((p) => p.szi !== 0).map((p) => [p.coin, { side: (p.szi > 0 ? "long" : "short") as Side, size: Math.abs(p.szi), marginUsdc: p.marginUsed }]));
    for (const p of positions) {
      const h = held.get(p.market);
      if (h && h.side === p.side) {
        if (h.size < p.size * 0.999) {
          await this.db.adjustSize(p.id, h.size, h.marginUsdc);
          await this.db.audit(owner, "position_reduced_externally", { positionId: p.id, market: p.market, from: p.size, to: h.size }, p.ruleId, p.followId);
        }
        continue;
      }
      // Gone: the fills after our last one say how (Hyperliquid's liquidation engine, or the owner by hand).
      const since = ((await this.db.lastFillAt(p.id)) ?? p.openedAt ?? 0) * 1000;
      const exitSide = p.side === "long" ? "A" : "B";
      const fills = (await ctx.fills(owner).catch(() => [] as Fill[])).filter((f) => f.coin === p.market && f.side === exitSide && f.time > since);
      const liquidated = fills.some((f) => f.liquidation);
      let exitPrice: number | null;
      let realized: number | null;
      let fees = 0;
      if (fills.length > 0) {
        const sz = fills.reduce((a, f) => a + f.sz, 0);
        exitPrice = fills.reduce((a, f) => a + f.px * f.sz, 0) / sz;
        fees = fills.reduce((a, f) => a + f.fee, 0);
        realized = fills.reduce((a, f) => a + f.closedPnl, 0) - fees;
      } else {
        exitPrice = ctx.mark(p.market);
        realized = exitPrice !== null && p.entryPrice !== null ? grossPnlUsdc({ side: p.side, entryPrice: p.entryPrice, size: p.size }, exitPrice) : null;
      }
      const reason = liquidated ? "liquidated on Hyperliquid" : fills.length > 0 ? "closed on Hyperliquid outside Autopilot" : "closed outside Autopilot (liquidated or closed by hand)";
      if (await this.db.closedExternally(p.id, { exitPrice, realizedUsdc: realized, feesUsdc: fees, reason, at: ctx.nowSec })) {
        await this.db.audit(owner, "position_closed_externally", { positionId: p.id, market: p.market, reason, exitPrice, realizedUsdc: realized, fills: fills.length }, p.ruleId, p.followId);
        this.log.warn({ position: p.id, owner, market: p.market, reason }, "position closed outside Autopilot");
      }
    }
  }
}
