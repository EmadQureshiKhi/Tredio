import { generateSealKeyPair, type Holding, type Rule, seal } from "@tredio/autopilot";
import type { AccountState } from "@tredio/hyperliquid";
import { Copier } from "../src/copier";
import type { ExecutorDb } from "../src/db";
import { Executor } from "../src/executor";
import { silentLog } from "../src/log";
import { AUTOPILOT_POLICY, Nonces, SessionVenue } from "../src/venue";
import { type GrantChain, Venues } from "../src/venues";
import { FakeAccount, FakeExchange, FakeRegistry, market, T } from "./fakes";

/**
 * Everything the executor touches, faked end to end except the database and the executor's own
 * code: accounts with sealed grants, Hyperliquid, Tredio's marks and mainnet leaders.
 */

export const USER = "0uuser";
export const BOT = "tredio-bot.testnet";
export const LEADER = "0x00000000000000000000000000000000000000b2";
export const TREND = "crypto:btc";

export const rule: Rule = {
  name: "BTC breakout",
  market: "BTC",
  trend: TREND,
  entry: { attentionChangePct: 20, windowMin: 60, minIndex: 0, smartMoney: "any", side: "long" },
  size: { marginUsdc: 20, leverage: 2 },
  exits: { stopLossPct: 5, takeProfitPct: 4, maxHoldMin: 0 },
  limits: { maxPositionUsdc: 100, maxDailyLossUsdc: 30, cooldownMin: 0 },
};

/** Mainnet as leaders' positions. */
export class FakeLeaders {
  readonly states = new Map<string, Map<string, Holding>>();
  readonly marks = new Map<string, number>([["BTC", 76_000]]);
  hold(leader: string, coin: string, h: Holding | null): void {
    const m = this.states.get(leader) ?? new Map<string, Holding>();
    if (h) m.set(coin, h);
    else m.delete(coin);
    this.states.set(leader, m);
  }
  source() {
    return {
      state: async (leader: string): Promise<AccountState> => ({
        accountValue: 0,
        withdrawable: 0,
        totalMarginUsed: 0,
        time: 0,
        positions: [...(this.states.get(leader) ?? new Map<string, Holding>()).entries()].map(([coin, h]) => ({
          coin,
          szi: h.side === "long" ? h.size : -h.size,
          entryPx: h.entryPrice ?? null,
          positionValue: 0,
          unrealizedPnl: 0,
          marginUsed: h.marginUsdc,
          leverage: 1,
          liquidationPx: null,
        })),
      }),
      marks: async () => this.marks,
    };
  }
}

export async function world(db: ExecutorDb) {
  const exchange = new FakeExchange([market("SOL", 0, 2, 90, 10), market("BTC", 3, 5, 76_000, 40), market("ETH", 4, 4, 2_260, 25)]);
  const registry = new FakeRegistry();
  for (const m of exchange.markets) registry.set(m.symbol, m.markPx);
  const pair = await generateSealKeyPair();
  /** Accounts by `${owner}|${session key}`. */
  const accounts = new Map<string, FakeAccount>();
  const add = (a: FakeAccount) => {
    accounts.set(`${a.account}|${a.key.publicKey}`, a);
    return a;
  };
  const user = add(new FakeAccount(USER));
  const bot = add(new FakeAccount(BOT));
  exchange.fund(user.address, 1_000);
  exchange.fund(bot.address, 1_000);
  const chain: GrantChain = {
    session: async (account, key) => (await accounts.get(`${account}|${key}`)?.session(account, key)) ?? null,
    accessKey: async (account, key) => (accounts.has(`${account}|${key}`) ? { kind: "function_call", receiverId: account, methodNames: ["session_call"], gasKey: true } : null),
  };
  const nonces = new Nonces(() => T * 1000);
  const addressOf = async (owner: string) => [...accounts.values()].find((a) => a.account === owner)!.address;
  const venues = new Venues(
    db,
    chain,
    (r) => {
      const a = accounts.get(`${r.owner}|${r.sessionKey}`)!;
      return new SessionVenue({
        owner: r.owner,
        kind: r.kind,
        sessionKey: r.sessionKey,
        network: "testnet",
        policy: AUTOPILOT_POLICY,
        chain: a,
        hyperliquid: exchange,
        addressOf: () => addressOf(r.owner),
        nonces,
        fund: async () => a.gas,
        gasMin: 31n * 10n ** 22n,
        postRetryMs: 1,
        checkTtlMs: 0,
        now: () => T * 1000,
      });
    },
    { sealPrivateKey: pair.privateKey, bot: { account: BOT, secretKey: bot.key.secretKey } },
    silentLog,
  );
  const leaders = new FakeLeaders();
  let copier: Copier | null = null;
  const executor = new Executor(
    db,
    async () => exchange.markets,
    registry.read,
    venues,
    { addressOf, state: (a) => exchange.accountState(a), fills: (a) => exchange.fills(a) },
    nonces,
    { slippageBps: 50, maxConsecutiveFailures: 3, maxAttempts: 5, orderStaleSec: 120, killEnv: false, netflowMaxAgeSec: 43_200, takerFeeBps: 4.5 },
    silentLog,
    async (ctx) => copier?.tick(ctx),
  );
  copier = new Copier(db, executor, leaders.source(), silentLog, "testnet");

  /** Grants Autopilot `a`'s session: the box sealed to the executor, as the app does, confirmed active. */
  const grant = async (a: FakeAccount) => {
    const box = await seal(a.key.secretKey, pair.publicKey, { owner: a.account, sessionKey: a.key.publicKey });
    await db.sql`
      INSERT INTO autopilot_grants (owner, session_key, sealed_key, status, valid_until, daily_limit) VALUES (${a.account}, ${a.key.publicKey}, ${box}, 'active', ${T + 7 * 86_400}, 500000000)
      ON CONFLICT (owner) DO UPDATE SET session_key = EXCLUDED.session_key, sealed_key = EXCLUDED.sealed_key, status = 'active', valid_until = EXCLUDED.valid_until`;
  };
  const addRule = async (r: Rule = rule, o: { owner?: string; route?: "api" | "session"; status?: string } = {}) => {
    const rows = await db.sql<{ id: string }[]>`
      INSERT INTO autopilot_rules (owner, rule, rule_hash, status, route) VALUES (${o.owner ?? USER}, ${db.sql.json(r as never)}, 'h', ${o.status ?? "enabled"}, ${o.route ?? "session"}) RETURNING id`;
    return Number(rows[0]!.id);
  };
  /** Moves the market: Hyperliquid's mark and Tredio's (fresh) mark together. */
  const price = (symbol: string, px: number) => {
    exchange.setMark(symbol, px);
    registry.set(symbol, px);
  };
  /** One executor tick at `nowSec`, with Tredio's marks and Hyperliquid's clock there too. */
  const tick = async (nowSec: number) => {
    registry.now = nowSec;
    exchange.now = () => nowSec * 1000;
    await executor.tick(nowSec);
  };
  /** Hyperliquid stops answering the next `n` order posts after running them (`ran`) or before. */
  const cutOrders = (n: number, ran: boolean) => {
    const post = exchange.post.bind(exchange);
    exchange.post = async (action, nonce, sig) => {
      if (action.type !== "order" || n <= 0) return post(action, nonce, sig);
      n--;
      if (ran) await post(action, nonce, sig);
      throw new Error("socket hang up");
    };
  };
  return { exchange, registry, pair, accounts, add, user, bot, venues, executor, leaders, grant, addRule, price, tick, cutOrders, sealPublic: pair.publicKey };
}

export type World = Awaited<ReturnType<typeof world>>;

export async function reset(db: ExecutorDb): Promise<void> {
  await db.sql`TRUNCATE autopilot_rules, autopilot_grants, autopilot_grant_keys, autopilot_positions, autopilot_orders, autopilot_audit, autopilot_control, follows, leader_holdings, index_points, index_sync, measurements RESTART IDENTITY CASCADE`;
  // Attention 40, then 60 from half an hour before T: +50% over the hour ending at T.
  await db.sql`INSERT INTO index_sync (trend_id, identifier, synced) VALUES (${TREND}, ${TREND}, ${T - 1800})`;
  await db.sql`INSERT INTO index_points (trend_id, observed_at, points) VALUES (${TREND}, ${T - 90_000}, 40), (${TREND}, ${T - 1800}, 60)`;
}

export const events = async (db: ExecutorDb, where: { ruleId?: number; followId?: number }) =>
  (
    await db.sql<{ event: string }[]>`
      SELECT event FROM autopilot_audit WHERE (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null}) AND (${where.followId ?? null}::bigint IS NULL OR follow_id = ${where.followId ?? null}) ORDER BY id`
  ).map((r) => r.event);

export const audits = async (db: ExecutorDb, event: string) => (await db.sql<{ detail: Record<string, unknown> }[]>`SELECT detail FROM autopilot_audit WHERE event = ${event} ORDER BY id`).map((r) => r.detail);

export const positions = (db: ExecutorDb, where: { ruleId?: number; followId?: number } = {}) =>
  db.sql<{ id: string; status: string; side: string; size: number; entry_price: number | null; exit_price: number | null; margin_usdc: number; leverage: number; pnl_usdc: number | null; fees_usdc: number; close_reason: string | null }[]>`
    SELECT id, status, side, size, entry_price, exit_price, margin_usdc, leverage, pnl_usdc, fees_usdc, close_reason FROM autopilot_positions
     WHERE (${where.ruleId ?? null}::bigint IS NULL OR rule_id = ${where.ruleId ?? null}) AND (${where.followId ?? null}::bigint IS NULL OR follow_id = ${where.followId ?? null}) ORDER BY id`;

export const orders = (db: ExecutorDb) =>
  db.sql<{ intent: string; action: string; status: string; request_id: string; size: number; worst_price: number; attempts: number; tx_hash: string | null; error: string | null }[]>`
    SELECT intent, action, status, request_id, size, worst_price, attempts, tx_hash, error FROM autopilot_orders ORDER BY id`;
