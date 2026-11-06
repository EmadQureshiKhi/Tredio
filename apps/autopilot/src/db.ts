import { type FollowSettings, type Holding, type Rule, type Side, withFollowDefaults } from "@tredio/autopilot";
import postgres from "postgres";

/**
 * The executor's reads and writes. The schema belongs to the backend (backend/src/db/migrations);
 * this only reads and writes its rows. The times its decisions read back (when an order was
 * created, a position opened or closed) come from the executor's own clock (`at`, unix seconds),
 * so a day, a cooldown or an order's age is measured on one clock.
 */

export type Sql = postgres.Sql;

/** A client for `url`: local databases skip TLS, hosted ones require it; `schema` scopes it (tests). */
export function connect(url: string, opts: { max?: number; schema?: string } = {}): Sql {
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  return postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: local ? false : "require",
    // Poolers in transaction mode do not keep prepared statements across connections.
    prepare: false,
    onnotice: () => {},
    connection: { application_name: "tredio-autopilot", ...(opts.schema ? { search_path: opts.schema } : {}) },
  });
}

export type RuleStatus = "draft" | "enabled" | "paused" | "stopped";
export type Route = "api" | "session";

export interface RuleRow {
  id: number;
  owner: string;
  rule: Rule;
  status: RuleStatus;
  route: Route;
}

export interface PositionRow {
  id: number;
  owner: string;
  ruleId: number | null;
  followId: number | null;
  market: string;
  side: Side;
  status: "opening" | "open" | "closing" | "closed" | "failed";
  size: number;
  entryPrice: number | null;
  marginUsdc: number;
  leverage: number;
  openedAt: number | null;
  feesUsdc: number;
}

export interface OrderRow {
  id: number;
  intent: string;
  owner: string;
  positionId: number | null;
  market: string;
  action: "open" | "close" | "reduce";
  side: Side;
  size: number;
  worstPrice: number;
  leverage: number;
  /** The order's Hyperliquid nonce, fixed when it is recorded so every attempt sends the same action. */
  nonce: number;
  status: "pending" | "sent" | "filled" | "unfilled" | "failed";
  attempts: number;
  txHash: string | null;
  reason: string | null;
  /** Unix seconds. */
  createdAt: number;
}

export interface GrantRow {
  owner: string;
  sessionKey: string;
  sealedKey: string;
  validUntil: number;
  dailyLimit: bigint;
  /** A replacement key the account asked for; it takes over once the account adds it on chain. */
  nextSessionKey: string | null;
  nextSealedKey: string | null;
}

export interface FollowRow {
  id: number;
  follower: string;
  leader: string;
  settings: FollowSettings;
  status: "active" | "paused" | "stopped";
  /** Its loss cap was reached: every open copy is being closed, whatever the status. */
  closingOut: boolean;
}

/** How an order ended, as recorded on the order and carried into its position. */
export interface OrderResult {
  status: "filled" | "unfilled" | "failed";
  txHash?: string | null;
  fillPrice?: number | null;
  fillSize?: number;
  feeUsdc?: number;
  /** Closes and reductions: the PnL of the size closed, before fees. */
  pnlUsdc?: number;
  /** Openings: the margin the fill posted. */
  marginUsdc?: number;
  error?: string | null;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const secs = (v: unknown) => (v instanceof Date ? Math.floor(v.getTime() / 1000) : null);
const ts = (sec: number) => new Date(sec * 1000);
/** A retired trend's return is listed as `<base>.2` up to `<base>.9`. */
const listingsOf = (identifier: string) => {
  const base = identifier.replace(/\.[2-9]$/, "");
  return [base, ...Array.from({ length: 8 }, (_, i) => `${base}.${i + 2}`)];
};

const toPosition = (r: Row): PositionRow => ({
  id: Number(r.id),
  owner: r.owner as string,
  ruleId: num(r.rule_id),
  followId: num(r.follow_id),
  market: r.market as string,
  side: r.side as Side,
  status: r.status as PositionRow["status"],
  size: Number(r.size),
  entryPrice: num(r.entry_price),
  marginUsdc: Number(r.margin_usdc),
  leverage: Number(r.leverage),
  openedAt: secs(r.opened_at),
  feesUsdc: Number(r.fees_usdc),
});

const toOrder = (r: Row): OrderRow => ({
  id: Number(r.id),
  intent: r.intent as string,
  owner: r.owner as string,
  positionId: num(r.position_id),
  market: r.market as string,
  action: r.action as OrderRow["action"],
  side: r.side as Side,
  size: Number(r.size),
  worstPrice: Number(r.worst_price),
  leverage: Number(r.leverage),
  nonce: Number(r.request_id),
  status: r.status as OrderRow["status"],
  attempts: Number(r.attempts),
  txHash: (r.tx_hash as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  createdAt: secs(r.created_at) ?? 0,
});

const toGrant = (r: Row): GrantRow => ({
  owner: r.owner as string,
  sessionKey: r.session_key as string,
  sealedKey: r.sealed_key as string,
  validUntil: Number(r.valid_until),
  dailyLimit: BigInt(r.daily_limit as string),
  nextSessionKey: (r.next_session_key as string | null) ?? null,
  nextSealedKey: (r.next_sealed_key as string | null) ?? null,
});

const toFollow = (r: Row): FollowRow => ({
  id: Number(r.id),
  follower: r.follower as string,
  leader: r.leader as string,
  settings: withFollowDefaults(r.settings as FollowSettings),
  status: r.status as FollowRow["status"],
  closingOut: Boolean(r.closing_out),
});

export class ExecutorDb {
  constructor(readonly sql: Sql) {}

  async killSwitch(): Promise<{ engaged: boolean; reason: string | null }> {
    const rows = await this.sql<{ value: { engaged: boolean; reason?: string | null } }[]>`SELECT value FROM autopilot_control WHERE key = 'kill'`;
    return { engaged: rows[0]?.value.engaged ?? false, reason: rows[0]?.value.reason ?? null };
  }

  // Rules ---------------------------------------------------------------------------------------

  /** Enabled rules, and paused or stopped ones that still hold a position to manage. */
  async rulesToRun(): Promise<RuleRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT r.id, r.owner, r.rule, r.status, r.route FROM autopilot_rules r
       WHERE r.status = 'enabled'
          OR (r.status IN ('paused', 'stopped') AND EXISTS (SELECT 1 FROM autopilot_positions p WHERE p.rule_id = r.id AND p.status IN ('opening', 'open', 'closing')))
       ORDER BY r.id`;
    return rows.map((r) => ({ id: Number(r.id), owner: r.owner as string, rule: r.rule as Rule, status: r.status as RuleStatus, route: r.route as Route }));
  }

  /** Pauses a rule that is still enabled (an owner's stop or pause since it was read stays); false when it was not. */
  async pauseRule(id: number, reason: string): Promise<boolean> {
    const rows = await this.sql`UPDATE autopilot_rules SET status = 'paused', status_reason = ${reason}, updated_at = now() WHERE id = ${id} AND status = 'enabled' RETURNING id`;
    return rows.length > 0;
  }

  async positionCount(ruleId: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM autopilot_positions WHERE rule_id = ${ruleId}`;
    return rows[0]?.n ?? 0;
  }

  async lastExitAt(ruleId: number): Promise<number | null> {
    const rows = await this.sql<{ at: Date | null }[]>`SELECT max(closed_at) AS at FROM autopilot_positions WHERE rule_id = ${ruleId} AND status = 'closed'`;
    return secs(rows[0]?.at);
  }

  /** Realized PnL of a rule's or a follow's closed positions during the UTC day of `nowSec`. */
  async realizedToday(where: { ruleId?: number; followId?: number }, nowSec: number): Promise<number> {
    const dayStart = Math.floor(nowSec / 86_400) * 86_400;
    const rows = await this.sql<{ pnl: number | null }[]>`
      SELECT sum(pnl_usdc)::float8 AS pnl FROM autopilot_positions
       WHERE status = 'closed' AND closed_at >= ${ts(dayStart)}
         AND (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null})
         AND (${where.followId ?? null}::bigint IS NULL OR follow_id = ${where.followId ?? null})`;
    return rows[0]?.pnl ?? 0;
  }

  /** Failed orders of a rule since its last order that did not fail. */
  async consecutiveFailures(ruleId: number): Promise<number> {
    const rows = await this.sql<{ status: string }[]>`
      SELECT o.status FROM autopilot_orders o JOIN autopilot_positions p ON p.id = o.position_id
       WHERE p.rule_id = ${ruleId} AND o.status IN ('filled', 'unfilled', 'failed') ORDER BY o.id DESC LIMIT 20`;
    let n = 0;
    for (const r of rows) {
      if (r.status !== "failed") break;
      n++;
    }
    return n;
  }

  // Attention and smart money -------------------------------------------------------------------

  /** The newest listing of a trend in the backend's index history (a returned trend is `<base>.<n>`). */
  async trendIdOf(identifier: string): Promise<string | null> {
    const listings = listingsOf(identifier);
    const rows = await this.sql<{ trend_id: string; identifier: string }[]>`SELECT trend_id, identifier FROM index_sync WHERE identifier = ANY(${this.sql.array(listings)})`;
    rows.sort((a, b) => listings.indexOf(b.identifier) - listings.indexOf(a.identifier));
    return rows[0]?.trend_id ?? null;
  }

  /** A trend's index points from the last one at or before the window's start up to `nowSec`: all the engine reads. */
  async attention(trendId: string, nowSec: number, windowSec: number): Promise<Array<{ t: number; v: number }>> {
    const start = nowSec - windowSec;
    const rows = await this.sql<{ observed_at: string; points: number }[]>`
      SELECT observed_at, points FROM index_points
       WHERE trend_id = ${trendId} AND observed_at <= ${nowSec}
         AND observed_at >= COALESCE((SELECT max(observed_at) FROM index_points WHERE trend_id = ${trendId} AND observed_at <= ${start}), ${start})
       ORDER BY observed_at`;
    return rows.map((r) => ({ t: Number(r.observed_at), v: r.points }));
  }

  /** The newest Nansen smart-money net flow (USD, 24 h) of a trend no older than `maxAgeSec`, or null. */
  async latestNetflow(identifier: string, nowSec: number, maxAgeSec: number): Promise<number | null> {
    const rows = await this.sql<{ value: number }[]>`
      SELECT value FROM measurements
       WHERE identifier = ANY(${this.sql.array(listingsOf(identifier))}) AND source = 'nansen' AND metric = 'netflow_usd'
         AND observed_at > ${ts(nowSec - maxAgeSec)} AND observed_at <= ${ts(nowSec)}
       ORDER BY observed_at DESC LIMIT 1`;
    return rows[0]?.value ?? null;
  }

  // Grants --------------------------------------------------------------------------------------

  async grants(): Promise<GrantRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT owner, session_key, sealed_key, valid_until, daily_limit, next_session_key, next_sealed_key FROM autopilot_grants WHERE status = 'active' ORDER BY owner`;
    return rows.map(toGrant);
  }

  async grant(owner: string): Promise<GrantRow | null> {
    const rows = await this.sql<Row[]>`
      SELECT owner, session_key, sealed_key, valid_until, daily_limit, next_session_key, next_sealed_key FROM autopilot_grants
       WHERE status = 'active' AND owner = ${owner.toLowerCase()}`;
    return rows[0] ? toGrant(rows[0]) : null;
  }

  /** Ends a grant, but only while `sessionKey` is still its key: a grant switched since it was read stays. Keys are case-sensitive. */
  async endGrant(owner: string, sessionKey: string, status: "revoked" | "expired"): Promise<boolean> {
    const rows = await this.sql`
      UPDATE autopilot_grants SET status = ${status}, updated_at = now() WHERE owner = ${owner.toLowerCase()} AND session_key = ${sessionKey} AND status = 'active' RETURNING owner`;
    return rows.length > 0;
  }

  /**
   * Moves a grant's waiting key into place with its on-chain terms, as the backend's grant confirmation
   * does; null when it is no longer the waiting key.
   */
  async switchGrant(owner: string, nextSessionKey: string, validUntil: number, dailyLimit: bigint): Promise<GrantRow | null> {
    const rows = await this.sql<Row[]>`
      UPDATE autopilot_grants SET session_key = next_session_key, sealed_key = next_sealed_key, next_session_key = NULL, next_sealed_key = NULL,
             status = 'active', valid_until = ${validUntil}, daily_limit = ${dailyLimit.toString()}, updated_at = now()
       WHERE owner = ${owner.toLowerCase()} AND next_session_key = ${nextSessionKey} AND next_sealed_key IS NOT NULL
      RETURNING owner, session_key, sealed_key, valid_until, daily_limit, next_session_key, next_sealed_key`;
    return rows[0] ? toGrant(rows[0]) : null;
  }

  // Positions -----------------------------------------------------------------------------------

  /** The live (not closed or failed) position of a rule, or of a follow in a market. */
  async livePosition(where: { ruleId?: number; followId?: number; market?: string }): Promise<PositionRow | null> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM autopilot_positions
       WHERE status IN ('opening', 'open', 'closing')
         AND (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null})
         AND (${where.followId ?? null}::bigint IS NULL OR follow_id = ${where.followId ?? null})
         AND (${where.market ?? null}::text IS NULL OR market = ${where.market ?? null})
       ORDER BY id DESC LIMIT 1`;
    return rows[0] ? toPosition(rows[0]) : null;
  }

  /** Open positions (no order in flight), for reconciliation against Hyperliquid. */
  async openPositions(): Promise<PositionRow[]> {
    return (await this.sql<Row[]>`SELECT * FROM autopilot_positions WHERE status = 'open' ORDER BY id`).map(toPosition);
  }

  /** An owner's live positions in a market: Hyperliquid nets one position per account and asset. */
  async liveInMarket(owner: string, market: string): Promise<PositionRow[]> {
    return (await this.sql<Row[]>`
      SELECT * FROM autopilot_positions WHERE owner = ${owner.toLowerCase()} AND market = ${market} AND status IN ('opening', 'open', 'closing') ORDER BY id`).map(toPosition);
  }

  async adjustSize(id: number, size: number, marginUsdc: number): Promise<void> {
    await this.sql`UPDATE autopilot_positions SET size = ${size}, margin_usdc = ${marginUsdc}, updated_at = now() WHERE id = ${id}`;
  }

  /** When the position's last filled order finished (unix seconds, the executor's clock), or null. */
  async lastFillAt(positionId: number): Promise<number | null> {
    const rows = await this.sql<{ at: Date | null }[]>`SELECT max(updated_at) AS at FROM autopilot_orders WHERE position_id = ${positionId} AND status = 'filled'`;
    return secs(rows[0]?.at);
  }

  async position(id: number): Promise<PositionRow | null> {
    const rows = await this.sql<Row[]>`SELECT * FROM autopilot_positions WHERE id = ${id}`;
    return rows[0] ? toPosition(rows[0]) : null;
  }

  /**
   * A position Hyperliquid closed without an order of ours (liquidation, or the owner by hand).
   * `realizedUsdc` is what the closing fills realized net of their fees (null when unknown); the
   * position's PnL adds it to what earlier reductions booked, less the fees paid to open.
   */
  async closedExternally(id: number, r: { exitPrice: number | null; realizedUsdc: number | null; feesUsdc: number; reason: string; at: number }): Promise<boolean> {
    const rows = await this.sql`
      UPDATE autopilot_positions SET status = 'closed', exit_price = ${r.exitPrice}, fees_usdc = fees_usdc + ${r.feesUsdc},
             pnl_usdc = CASE WHEN ${r.realizedUsdc}::float8 IS NULL THEN NULL ELSE COALESCE(pnl_usdc, 0) + ${r.realizedUsdc}::float8
               - (SELECT COALESCE(sum(fee_usdc), 0)::float8 FROM autopilot_orders WHERE position_id = ${id} AND action = 'open' AND status = 'filled') END,
             close_reason = ${r.reason}, closed_at = ${ts(r.at)}, updated_at = now()
       WHERE id = ${id} AND status = 'open' RETURNING id`;
    return rows.length > 0;
  }

  // Orders --------------------------------------------------------------------------------------

  /**
   * Starts an order idempotently: the intent is unique, so a retry finds the order it already
   * started instead of creating another. An opening creates its position in the same transaction.
   */
  async startOrder(o: {
    intent: string;
    owner: string;
    market: string;
    action: OrderRow["action"];
    side: Side;
    size: number;
    worstPrice: number;
    leverage: number;
    nonce: number;
    reason: string;
    at: number;
    position: { existingId: number } | { ruleId: number | null; followId: number | null; signal: Record<string, unknown> };
  }): Promise<{ order: OrderRow; created: boolean }> {
    const existing = await this.sql<Row[]>`SELECT * FROM autopilot_orders WHERE intent = ${o.intent}`;
    if (existing[0]) return { order: toOrder(existing[0]), created: false };
    const owner = o.owner.toLowerCase();
    return this.sql.begin(async (tx) => {
      let positionId: number;
      if ("existingId" in o.position) {
        positionId = o.position.existingId;
        await tx`UPDATE autopilot_positions SET status = ${o.action === "open" ? "opening" : "closing"}, updated_at = now() WHERE id = ${positionId}`;
      } else {
        const rows = await tx<{ id: string }[]>`
          INSERT INTO autopilot_positions (owner, rule_id, follow_id, market, side, status, leverage, signal)
          VALUES (${owner}, ${o.position.ruleId}, ${o.position.followId}, ${o.market}, ${o.side}, 'opening', ${o.leverage}, ${tx.json(o.position.signal as never)})
          RETURNING id`;
        positionId = Number(rows[0]!.id);
      }
      const rows = await tx<Row[]>`
        INSERT INTO autopilot_orders (intent, owner, position_id, market, action, side, size, worst_price, leverage, request_id, reason, created_at)
        VALUES (${o.intent}, ${owner}, ${positionId}, ${o.market}, ${o.action}, ${o.side}, ${o.size}, ${o.worstPrice}, ${o.leverage}, ${o.nonce}, ${o.reason}, ${ts(o.at)})
        RETURNING *`;
      return { order: toOrder(rows[0]!), created: true };
    });
  }

  /** The account signed the order on chain; Hyperliquid's answer comes next. */
  async orderSent(id: number, txHash: string): Promise<void> {
    await this.sql`UPDATE autopilot_orders SET status = 'sent', tx_hash = ${txHash}, attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = ${id}`;
  }

  /** An attempt that may succeed later; the order stays in flight. Returns the attempts so far. */
  async orderRetry(id: number, error: string): Promise<number> {
    const rows = await this.sql<{ attempts: number }[]>`
      UPDATE autopilot_orders SET attempts = attempts + CASE WHEN status = 'sent' THEN 0 ELSE 1 END, error = ${error.slice(0, 500)}, updated_at = now() WHERE id = ${id} RETURNING attempts`;
    return rows[0]?.attempts ?? 0;
  }

  /** Orders placed for a position so far, so each new attempt gets its own intent. */
  async orderCount(positionId: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM autopilot_orders WHERE position_id = ${positionId}`;
    return rows[0]?.n ?? 0;
  }

  async openOrders(): Promise<OrderRow[]> {
    return (await this.sql<Row[]>`SELECT * FROM autopilot_orders WHERE status IN ('pending', 'sent') ORDER BY id`).map(toOrder);
  }

  /** Records an order's final result and moves its position on. */
  async orderDone(o: OrderRow, r: OrderResult & { closeReason?: string; at: number }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE autopilot_orders SET status = ${r.status}, tx_hash = COALESCE(${r.txHash ?? null}, tx_hash), fill_price = ${r.fillPrice ?? null}, fill_size = ${r.fillSize ?? null},
               fee_usdc = ${r.feeUsdc ?? null}, pnl_usdc = ${r.pnlUsdc ?? null}, error = ${r.error?.slice(0, 500) ?? null}, updated_at = ${ts(r.at)}
         WHERE id = ${o.id}`;
      if (o.positionId === null) return;
      const p = (await tx<Row[]>`SELECT * FROM autopilot_positions WHERE id = ${o.positionId} FOR UPDATE`)[0];
      if (!p) return;
      const pos = toPosition(p);
      const fee = r.feeUsdc ?? 0;
      const filled = r.status === "filled" && (r.fillSize ?? 0) > 0;
      if (o.action === "open") {
        if (!filled) {
          // Nothing was added: a new position failed; an increase leaves the position as it was.
          if (pos.size > 0) await tx`UPDATE autopilot_positions SET status = 'open', updated_at = now() WHERE id = ${pos.id}`;
          else await tx`UPDATE autopilot_positions SET status = 'failed', close_reason = ${(r.error ?? r.status).slice(0, 300)}, updated_at = now() WHERE id = ${pos.id}`;
          return;
        }
        const size = pos.size + r.fillSize!;
        const entry = pos.size > 0 && pos.entryPrice ? (pos.entryPrice * pos.size + (r.fillPrice ?? 0) * r.fillSize!) / size : (r.fillPrice ?? null);
        await tx`
          UPDATE autopilot_positions SET status = 'open', size = ${size}, entry_price = ${entry}, margin_usdc = margin_usdc + ${r.marginUsdc ?? 0},
                 fees_usdc = fees_usdc + ${fee}, opened_at = COALESCE(opened_at, ${ts(r.at)}), updated_at = now()
           WHERE id = ${pos.id}`;
        return;
      }
      if (!filled) {
        await tx`UPDATE autopilot_positions SET status = 'open', updated_at = now() WHERE id = ${pos.id}`;
        return;
      }
      const remaining = Math.max(0, pos.size - r.fillSize!);
      const realized = (r.pnlUsdc ?? 0) - fee;
      if (remaining <= pos.size * 1e-6) {
        // Net PnL: every reduction's PnL net of its fee, less the fees paid to open.
        const opened = await tx<{ fees: number }[]>`
          SELECT COALESCE(sum(fee_usdc), 0)::float8 AS fees FROM autopilot_orders WHERE position_id = ${pos.id} AND action = 'open' AND status = 'filled'`;
        await tx`
          UPDATE autopilot_positions SET status = 'closed', size = 0, exit_price = ${r.fillPrice ?? null}, closed_at = ${ts(r.at)},
                 pnl_usdc = COALESCE(pnl_usdc, 0) + ${realized - (opened[0]?.fees ?? 0)}, fees_usdc = fees_usdc + ${fee}, close_reason = ${r.closeReason ?? "close"}, updated_at = now()
           WHERE id = ${pos.id}`;
      } else {
        // A partial reduction books its PnL now; opening fees are charged when the position closes.
        await tx`
          UPDATE autopilot_positions SET status = 'open', size = ${remaining}, margin_usdc = margin_usdc * ${remaining / pos.size},
                 pnl_usdc = COALESCE(pnl_usdc, 0) + ${realized}, fees_usdc = fees_usdc + ${fee}, updated_at = now()
           WHERE id = ${pos.id}`;
      }
    });
  }

  async audit(owner: string, event: string, detail: Record<string, unknown>, ruleId: number | null = null, followId: number | null = null): Promise<void> {
    await this.sql`INSERT INTO autopilot_audit (owner, rule_id, follow_id, event, detail) VALUES (${owner.toLowerCase()}, ${ruleId}, ${followId}, ${event}, ${this.sql.json(detail as never)})`;
  }

  // Copy-trading --------------------------------------------------------------------------------

  /** Follows that copy now: active, with an active grant, and not being closed out. */
  async activeFollows(): Promise<FollowRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT f.id, f.follower, f.leader, f.settings, f.status, f.closing_out FROM follows f
        JOIN autopilot_grants g ON g.owner = f.follower AND g.status = 'active'
       WHERE f.status = 'active' AND NOT f.closing_out ORDER BY f.id`;
    return rows.map(toFollow);
  }

  /** Follows whose loss cap needs watching (active ones holding copies) or acting on (being closed out). */
  async followsToGuard(): Promise<FollowRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT f.id, f.follower, f.leader, f.settings, f.status, f.closing_out FROM follows f
       WHERE f.closing_out
          OR (f.status = 'active' AND EXISTS (SELECT 1 FROM autopilot_positions p WHERE p.follow_id = f.id AND p.status IN ('opening', 'open', 'closing')))
       ORDER BY f.id`;
    return rows.map(toFollow);
  }

  /** The live (not closed or failed) positions a follow copied. */
  async followPositions(followId: number): Promise<PositionRow[]> {
    return (await this.sql<Row[]>`SELECT * FROM autopilot_positions WHERE follow_id = ${followId} AND status IN ('opening', 'open', 'closing') ORDER BY id`).map(toPosition);
  }

  /** Orders placed for a follow so far, so each copy gets its own intent. */
  async followOrderCount(followId: number): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM autopilot_orders o JOIN autopilot_positions p ON p.id = o.position_id WHERE p.follow_id = ${followId}`;
    return rows[0]?.n ?? 0;
  }

  /** Pauses a follow at its loss cap and marks it for closing out; false when it already was. */
  async startCloseOut(id: number, reason: string): Promise<boolean> {
    const rows = await this.sql`UPDATE follows SET status = 'paused', status_reason = ${reason}, closing_out = true, updated_at = now() WHERE id = ${id} AND NOT closing_out RETURNING id`;
    return rows.length > 0;
  }

  /** A closed-out follow holds no copies any more. */
  async endCloseOut(id: number): Promise<void> {
    await this.sql`UPDATE follows SET closing_out = false, updated_at = now() WHERE id = ${id}`;
  }

  /** The last snapshot of a leader: whether one was ever taken, and the markets it held. */
  async leaderSnapshot(leader: string): Promise<{ seen: boolean; holdings: Map<string, Holding> }> {
    const rows = await this.sql<{ market: string; side: Side | null; size: number; margin_usdc: number; entry_price: number | null }[]>`
      SELECT market, side, size, margin_usdc, entry_price FROM leader_holdings WHERE leader = ${leader.toLowerCase()}`;
    const holdings = new Map(rows.filter((r) => r.side && r.size > 0).map((r) => [r.market, { side: r.side!, size: r.size, marginUsdc: r.margin_usdc, entryPrice: r.entry_price }]));
    return { seen: rows.length > 0, holdings };
  }

  /** Stores a leader's holdings per market; a market the leader left keeps a flat row. */
  async saveLeaderHoldings(leader: string, rows: ReadonlyArray<{ market: string; holding: Holding | null }>, at: number): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      leader: leader.toLowerCase(),
      market: r.market,
      side: r.holding?.side ?? null,
      size: r.holding?.size ?? 0,
      margin_usdc: r.holding?.marginUsdc ?? 0,
      entry_price: r.holding?.entryPrice ?? null,
      seen_at: ts(at),
    }));
    await this.sql`
      INSERT INTO leader_holdings ${this.sql(values, "leader", "market", "side", "size", "margin_usdc", "entry_price", "seen_at")}
      ON CONFLICT (leader, market) DO UPDATE SET side = EXCLUDED.side, size = EXCLUDED.size, margin_usdc = EXCLUDED.margin_usdc, entry_price = EXCLUDED.entry_price, seen_at = EXCLUDED.seen_at`;
  }

  // Health --------------------------------------------------------------------------------------

  async stats(nowSec: number): Promise<{ rules: number; grants: number; follows: number; leaders: number; inFlight: number; today: { filled: number; unfilled: number; failed: number } }> {
    const dayStart = ts(Math.floor(nowSec / 86_400) * 86_400);
    const [r] = await this.sql<{ rules: number; grants: number; follows: number; leaders: number; in_flight: number; filled: number; unfilled: number; failed: number }[]>`
      SELECT
        (SELECT count(*)::int FROM autopilot_rules WHERE status = 'enabled') AS rules,
        (SELECT count(*)::int FROM autopilot_grants WHERE status = 'active') AS grants,
        (SELECT count(*)::int FROM follows WHERE status = 'active') AS follows,
        (SELECT count(DISTINCT leader)::int FROM follows WHERE status = 'active') AS leaders,
        (SELECT count(*)::int FROM autopilot_orders WHERE status IN ('pending', 'sent')) AS in_flight,
        (SELECT count(*)::int FROM autopilot_orders WHERE status = 'filled' AND updated_at >= ${dayStart}) AS filled,
        (SELECT count(*)::int FROM autopilot_orders WHERE status = 'unfilled' AND updated_at >= ${dayStart}) AS unfilled,
        (SELECT count(*)::int FROM autopilot_orders WHERE status = 'failed' AND updated_at >= ${dayStart}) AS failed`;
    return { rules: r!.rules, grants: r!.grants, follows: r!.follows, leaders: r!.leaders, inFlight: r!.in_flight, today: { filled: r!.filled, unfilled: r!.unfilled, failed: r!.failed } };
  }
}
