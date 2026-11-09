import { createHash } from "node:crypto";
import { type BacktestResult, type ClosedTrade, type FollowSettings, type Rule, withFollowDefaults } from "@tredio/autopilot";
import type { Sql } from "../db";

/** Autopilot, grants and copy-trading tables. */

export type RuleStatus = "draft" | "enabled" | "paused" | "stopped";
/** How a rule trades: through the asset perps API or through the account's session. */
export type Route = "api" | "session";

export interface StoredRule {
  id: number;
  owner: string;
  rule: Rule;
  ruleHash: string;
  status: RuleStatus;
  route: Route;
  backtestId: number | null;
  statusReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Grant {
  owner: string;
  sessionKey: string;
  status: "pending" | "active" | "revoked" | "expired";
  validUntil: number;
  dailyLimit: bigint;
  /** A key requested while this grant is active; it takes over once the account adds it. */
  nextSessionKey: string | null;
}

export interface Follow {
  id: number;
  follower: string;
  leader: string;
  settings: FollowSettings;
  status: "active" | "paused" | "stopped";
  statusReason: string | null;
  createdAt: Date;
}

/** Stable hash of a rule, so a backtest is tied to exactly the rule that is enabled. */
export function ruleHash(rule: Rule): string {
  const canonical = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
  return createHash("sha256").update(JSON.stringify(canonical(rule))).digest("hex").slice(0, 32);
}

interface RuleRow {
  id: string;
  owner: string;
  rule: Rule;
  rule_hash: string;
  status: RuleStatus;
  route: Route;
  backtest_id: string | null;
  status_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const toRule = (r: RuleRow): StoredRule => ({
  id: Number(r.id),
  owner: r.owner,
  rule: r.rule,
  ruleHash: r.rule_hash,
  status: r.status,
  route: r.route,
  backtestId: r.backtest_id === null ? null : Number(r.backtest_id),
  statusReason: r.status_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class AutopilotStore {
  constructor(readonly sql: Sql) {}

  async createRule(owner: string, rule: Rule, route: Route): Promise<StoredRule> {
    const rows = await this.sql<RuleRow[]>`
      INSERT INTO autopilot_rules (owner, rule, rule_hash, route) VALUES (${owner.toLowerCase()}, ${this.sql.json(rule as never)}, ${ruleHash(rule)}, ${route})
      RETURNING *`;
    return toRule(rows[0]!);
  }

  async rule(id: number): Promise<StoredRule | null> {
    const rows = await this.sql<RuleRow[]>`SELECT * FROM autopilot_rules WHERE id = ${id}`;
    return rows[0] ? toRule(rows[0]) : null;
  }

  async rulesOf(owner: string): Promise<StoredRule[]> {
    const rows = await this.sql<RuleRow[]>`SELECT * FROM autopilot_rules WHERE owner = ${owner.toLowerCase()} AND status <> 'stopped' ORDER BY updated_at DESC`;
    return rows.map(toRule);
  }

  async enabledRules(): Promise<StoredRule[]> {
    const rows = await this.sql<RuleRow[]>`SELECT * FROM autopilot_rules WHERE status = 'enabled' ORDER BY id`;
    return rows.map(toRule);
  }

  /** Replaces a rule that is not running; its backtest no longer applies. */
  async updateRule(id: number, owner: string, rule: Rule): Promise<StoredRule | null> {
    const rows = await this.sql<RuleRow[]>`
      UPDATE autopilot_rules SET rule = ${this.sql.json(rule as never)}, rule_hash = ${ruleHash(rule)}, backtest_id = NULL, updated_at = now()
       WHERE id = ${id} AND owner = ${owner.toLowerCase()} AND status IN ('draft', 'paused')
      RETURNING *`;
    return rows[0] ? toRule(rows[0]) : null;
  }

  async setStatus(id: number, status: RuleStatus, reason: string | null, backtestId?: number): Promise<StoredRule | null> {
    const rows = await this.sql<RuleRow[]>`
      UPDATE autopilot_rules SET status = ${status}, status_reason = ${reason}, backtest_id = COALESCE(${backtestId ?? null}, backtest_id), updated_at = now()
       WHERE id = ${id} RETURNING *`;
    return rows[0] ? toRule(rows[0]) : null;
  }

  async saveBacktest(owner: string, rule: Rule, result: BacktestResult): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO autopilot_backtests (owner, rule, rule_hash, result) VALUES (${owner.toLowerCase()}, ${this.sql.json(rule as never)}, ${ruleHash(rule)}, ${this.sql.json(result as never)})
      RETURNING id`;
    return Number(rows[0]!.id);
  }

  /** The newest backtest of exactly this rule within `maxAgeSec`, or null. */
  async recentBacktest(owner: string, hash: string, maxAgeSec: number): Promise<{ id: number; result: BacktestResult; createdAt: Date } | null> {
    const rows = await this.sql<{ id: string; result: BacktestResult; created_at: Date }[]>`
      SELECT id, result, created_at FROM autopilot_backtests
       WHERE owner = ${owner.toLowerCase()} AND rule_hash = ${hash} AND created_at > now() - make_interval(secs => ${maxAgeSec})
       ORDER BY created_at DESC LIMIT 1`;
    const r = rows[0];
    return r ? { id: Number(r.id), result: r.result, createdAt: r.created_at } : null;
  }

  async backtest(id: number): Promise<{ id: number; owner: string; rule: Rule; result: BacktestResult; createdAt: Date } | null> {
    const rows = await this.sql<{ id: string; owner: string; rule: Rule; result: BacktestResult; created_at: Date }[]>`SELECT * FROM autopilot_backtests WHERE id = ${id}`;
    const r = rows[0];
    return r ? { id: Number(r.id), owner: r.owner, rule: r.rule, result: r.result, createdAt: r.created_at } : null;
  }

  async grant(owner: string): Promise<Grant | null> {
    const rows = await this.sql<{ owner: string; session_key: string; status: Grant["status"]; valid_until: string; daily_limit: string; next_session_key: string | null }[]>`
      SELECT owner, session_key, status, valid_until, daily_limit, next_session_key FROM autopilot_grants WHERE owner = ${owner.toLowerCase()}`;
    const r = rows[0];
    return r ? { owner: r.owner, sessionKey: r.session_key, status: r.status, validUntil: Number(r.valid_until), dailyLimit: BigInt(r.daily_limit), nextSessionKey: r.next_session_key } : null;
  }

  /**
   * Records a newly requested key. While a grant is active and unexpired, the new key waits beside it
   * and the active key keeps trading until the account adds the new one; otherwise the new key replaces
   * the grant as pending. Every grant key is remembered. Null when the key is already another
   * account's grant key (the app generates keys, so a key seen before is never genuine).
   */
  async requestGrant(owner: string, sessionKey: string, sealedKey: string, nowSec: number): Promise<{ replaces: string | null } | null> {
    return this.sql.begin(async (tx) => {
      const known = await tx<{ owner: string }[]>`
        INSERT INTO autopilot_grant_keys (session_key, owner) VALUES (${sessionKey}, ${owner.toLowerCase()})
        ON CONFLICT (session_key) DO UPDATE SET owner = autopilot_grant_keys.owner
        RETURNING owner`;
      if (known[0]?.owner !== owner.toLowerCase()) return null;
      const rows = await tx<{ status: Grant["status"]; session_key: string }[]>`
        INSERT INTO autopilot_grants AS g (owner, session_key, sealed_key, status) VALUES (${owner.toLowerCase()}, ${sessionKey}, ${sealedKey}, 'pending')
        ON CONFLICT (owner) DO UPDATE SET
          session_key = CASE WHEN g.status = 'active' AND g.valid_until > ${nowSec} THEN g.session_key ELSE EXCLUDED.session_key END,
          sealed_key = CASE WHEN g.status = 'active' AND g.valid_until > ${nowSec} THEN g.sealed_key ELSE EXCLUDED.sealed_key END,
          next_session_key = CASE WHEN g.status = 'active' AND g.valid_until > ${nowSec} THEN EXCLUDED.session_key END,
          next_sealed_key = CASE WHEN g.status = 'active' AND g.valid_until > ${nowSec} THEN EXCLUDED.sealed_key END,
          status = CASE WHEN g.status = 'active' AND g.valid_until > ${nowSec} THEN g.status ELSE 'pending' END,
          valid_until = CASE WHEN g.status = 'active' AND g.valid_until > ${nowSec} THEN g.valid_until ELSE 0 END,
          daily_limit = CASE WHEN g.status = 'active' AND g.valid_until > ${nowSec} THEN g.daily_limit ELSE 0 END,
          updated_at = now()
        RETURNING status, session_key`;
      const r = rows[0]!;
      return { replaces: r.status === "active" ? r.session_key : null };
    });
  }

  /**
   * True for a key `account` asked to grant Autopilot, current or replaced: it belongs to the
   * executor, not the account. Per account, so naming another account's session key in a grant
   * request cannot lock that account out.
   */
  async isGrantKey(account: string, key: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM autopilot_grant_keys WHERE session_key = ${key} AND owner = ${account.toLowerCase()}
      UNION ALL SELECT 1 FROM autopilot_grants WHERE owner = ${account.toLowerCase()} AND (session_key = ${key} OR next_session_key = ${key}) LIMIT 1`;
    return rows.length > 0;
  }

  /**
   * Makes `sessionKey` the account's active grant with the terms the account granted: the current key (a first
   * grant, or a refresh) or the waiting one, which then replaces it. False when the grant has moved
   * on to another key since it was read.
   */
  async activateGrant(owner: string, sessionKey: string, validUntil: number, dailyLimit: bigint): Promise<boolean> {
    const key = sessionKey;
    const rows = await this.sql`
      UPDATE autopilot_grants SET
        sealed_key = CASE WHEN next_session_key = ${key} THEN next_sealed_key ELSE sealed_key END,
        session_key = ${key}, next_session_key = NULL, next_sealed_key = NULL,
        status = 'active', valid_until = ${validUntil}, daily_limit = ${dailyLimit.toString()}, updated_at = now()
       WHERE owner = ${owner.toLowerCase()} AND (next_session_key = ${key} OR (session_key = ${key} AND next_session_key IS NULL))
      RETURNING owner`;
    return rows.length > 0;
  }

  async setGrantStatus(owner: string, status: Grant["status"]): Promise<void> {
    await this.sql`UPDATE autopilot_grants SET status = ${status}, updated_at = now() WHERE owner = ${owner.toLowerCase()}`;
  }

  /** Closed positions of a rule (or of every rule and copy of an owner), as trades. */
  async closedTrades(where: { ruleId?: number; owner?: string; followId?: number }): Promise<ClosedTrade[]> {
    const rows = await this.sql<
      { side: "long" | "short"; opened_at: Date; closed_at: Date; entry_price: number; exit_price: number; size: number; margin_usdc: number; pnl_usdc: number; fees_usdc: number; close_reason: string }[]
    >`
      SELECT side, opened_at, closed_at, entry_price, exit_price, size, margin_usdc, pnl_usdc, fees_usdc, close_reason
        FROM autopilot_positions
       WHERE status = 'closed' AND pnl_usdc IS NOT NULL
         AND (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null})
         AND (${where.followId ?? null}::bigint IS NULL OR follow_id = ${where.followId ?? null})
         AND (${where.owner?.toLowerCase() ?? null}::text IS NULL OR owner = ${where.owner?.toLowerCase() ?? null})
       ORDER BY closed_at`;
    return rows.map((r) => ({
      side: r.side,
      openedAt: Math.floor(r.opened_at.getTime() / 1000),
      closedAt: Math.floor(r.closed_at.getTime() / 1000),
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      size: r.size,
      marginUsdc: r.margin_usdc,
      pnlUsdc: r.pnl_usdc,
      feesUsdc: r.fees_usdc,
      reason: r.close_reason,
    }));
  }

  async positions(where: { ruleId?: number; owner?: string }, limit = 50) {
    return this.sql<
      {
        id: string;
        rule_id: string | null;
        follow_id: string | null;
        market: string;
        side: string;
        status: string;
        size: number;
        entry_price: number | null;
        margin_usdc: number;
        leverage: number;
        opened_at: Date | null;
        closed_at: Date | null;
        exit_price: number | null;
        pnl_usdc: number | null;
        fees_usdc: number;
        close_reason: string | null;
        signal: Record<string, unknown>;
      }[]
    >`
      SELECT id, rule_id, follow_id, market, side, status, size, entry_price, margin_usdc, leverage, opened_at, closed_at, exit_price, pnl_usdc, fees_usdc, close_reason, signal
        FROM autopilot_positions
       WHERE (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null})
         AND (${where.owner?.toLowerCase() ?? null}::text IS NULL OR owner = ${where.owner?.toLowerCase() ?? null})
       ORDER BY created_at DESC LIMIT ${limit}`;
  }

  async audit(where: { ruleId?: number; owner?: string }, limit = 100) {
    return this.sql<{ id: string; at: Date; event: string; rule_id: string | null; follow_id: string | null; detail: Record<string, unknown> }[]>`
      SELECT id, at, event, rule_id, follow_id, detail FROM autopilot_audit
       WHERE (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null})
         AND (${where.owner?.toLowerCase() ?? null}::text IS NULL OR owner = ${where.owner?.toLowerCase() ?? null})
       ORDER BY id DESC LIMIT ${limit}`;
  }

  async addAudit(owner: string, event: string, detail: Record<string, unknown>, ruleId: number | null = null, followId: number | null = null): Promise<void> {
    await this.sql`INSERT INTO autopilot_audit (owner, rule_id, follow_id, event, detail) VALUES (${owner.toLowerCase()}, ${ruleId}, ${followId}, ${event}, ${this.sql.json(detail as never)})`;
  }

  async killSwitch(): Promise<{ engaged: boolean; reason: string | null; updatedBy: string | null; updatedAt: Date | null }> {
    const rows = await this.sql<{ value: { engaged: boolean; reason?: string }; updated_by: string | null; updated_at: Date }[]>`
      SELECT value, updated_by, updated_at FROM autopilot_control WHERE key = 'kill'`;
    const r = rows[0];
    return { engaged: r?.value.engaged ?? false, reason: r?.value.reason ?? null, updatedBy: r?.updated_by ?? null, updatedAt: r?.updated_at ?? null };
  }

  async setKillSwitch(engaged: boolean, reason: string | null, by: string): Promise<void> {
    await this.sql`
      INSERT INTO autopilot_control (key, value, updated_by) VALUES ('kill', ${this.sql.json({ engaged, reason } as never)}, ${by.toLowerCase()})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }

  async follows(where: { follower?: string; leader?: string }): Promise<Follow[]> {
    const rows = await this.sql<{ id: string; follower: string; leader: string; settings: FollowSettings; status: Follow["status"]; status_reason: string | null; created_at: Date }[]>`
      SELECT * FROM follows
       WHERE (${where.follower?.toLowerCase() ?? null}::text IS NULL OR follower = ${where.follower?.toLowerCase() ?? null})
         AND (${where.leader?.toLowerCase() ?? null}::text IS NULL OR leader = ${where.leader?.toLowerCase() ?? null})
         AND status <> 'stopped'
       ORDER BY created_at DESC`;
    return rows.map((r) => ({ id: Number(r.id), follower: r.follower, leader: r.leader, settings: withFollowDefaults(r.settings), status: r.status, statusReason: r.status_reason, createdAt: r.created_at }));
  }

  /** Starts a follow or sets new caps; either way it copies again, and a loss-cap close-out ends. */
  async upsertFollow(follower: string, leader: string, settings: FollowSettings): Promise<Follow> {
    const rows = await this.sql<{ id: string; follower: string; leader: string; settings: FollowSettings; status: Follow["status"]; status_reason: string | null; created_at: Date }[]>`
      INSERT INTO follows (follower, leader, settings) VALUES (${follower.toLowerCase()}, ${leader.toLowerCase()}, ${this.sql.json(settings as never)})
      ON CONFLICT (follower, leader) DO UPDATE SET settings = EXCLUDED.settings, status = 'active', status_reason = NULL, closing_out = false, updated_at = now()
      RETURNING *`;
    const r = rows[0]!;
    return { id: Number(r.id), follower: r.follower, leader: r.leader, settings: r.settings, status: r.status, statusReason: r.status_reason, createdAt: r.created_at };
  }

  /** Resuming ends a loss-cap close-out (the executor checks the cap again); pausing and stopping leave it running. */
  async setFollowStatus(id: number, follower: string, status: Follow["status"]): Promise<boolean> {
    const rows = await this.sql`
      UPDATE follows SET status = ${status}, status_reason = NULL, closing_out = closing_out AND ${status !== "active"}, updated_at = now()
       WHERE id = ${id} AND follower = ${follower.toLowerCase()} RETURNING id`;
    return rows.length > 0;
  }

  async followerCount(leader: string): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM follows WHERE leader = ${leader.toLowerCase()} AND status = 'active'`;
    return rows[0]?.n ?? 0;
  }
}
