import { equityCurve, followSettingsSchema, type Rule, ruleSchema, boxKeyId, sealKeyId, sessionLeverageProblem, stats } from "@tredio/autopilot";
import { ownerRequests } from "@tredio/contracts";
import { type HyperliquidInfo, hyperliquidAddressOf } from "@tredio/hyperliquid";
import { Hono } from "hono";
import { z } from "zod";
import { tokenHash } from "../api/admin-auth";
import type { AccessKeyReader } from "../api/near-auth";
import type { OwnerApprovals } from "../api/owner-approval";
import { rateLimit } from "../api/rate-limit";
import { type AccountKeys, ChainUnavailableError, issueUserToken, type SessionReader, SignInError, userAuth } from "../api/user-auth";
import type { Log } from "../log";
import type { AutopilotService } from "./service";
import { type AutopilotStore, ruleHash, type StoredRule } from "./store";

/**
 * Autopilot and copy-trading API. Accounts sign in, build rules, backtest them, grant Autopilot a
 * session of its own (a gas key the account contract limits to Hyperliquid orders, under the
 * contract's price and leverage guard and a daily cap) and enable rules that were backtested as
 * they stand. The app generates that key and seals it to the executor, so this server only ever
 * stores the sealed box. Copy-trading follows a Hyperliquid leader within the follower's own caps.
 * Admins run the Tredio bot's rules and the kill switch. Following (or resuming a follow) and
 * enabling a rule keep trading after the session that asked is gone, so they also need the account
 * passkey's approval; pausing and stopping never do.
 */

/** The label the app gives an Autopilot session; the executor trades only through sessions with it. */
export const AUTOPILOT_LABEL = "autopilot";
/** The account contract's leverage cap for session orders on Hyperliquid (`HL_MAX_LEVERAGE`). */
export const SESSION_MAX_LEVERAGE = 10;

export interface AutopilotRouteDeps {
  isRevoked: (tokenHash: string) => Promise<boolean>;
  revoke: (tokenHash: string, expiresAt: number) => Promise<void>;
  store: AutopilotStore;
  service: AutopilotService;
  /** Hyperliquid on the deployment's network, for markets, positions and leaders. */
  hyperliquid: HyperliquidInfo;
  /** Reads an account's session (`session` view) and access keys, to confirm grants on chain. */
  sessions: SessionReader;
  accessKey: AccessKeyReader;
  /** Contract views, for the Hyperliquid address of an account. */
  view: <T>(contractId: string, method: string, args: object) => Promise<T>;
  /** The Chain Signatures contract (deployment `external.chainSignatures`). */
  signer: string;
  /** Which keys may sign in as an account, and whether they still may. */
  keys: AccountKeys;
  /** The account passkey's approval, which following and enabling rules need. */
  approvals: Pick<OwnerApprovals, "check">;
  sessionSecret: string;
  /** The executor's public key: the app seals grants to it. */
  sealPublicKey: string | undefined;
  /** The Tredio bot's own account (its rules run on route "api"). */
  botAccount: string | undefined;
  log: Log;
  now?: () => number;
}

export const BACKTEST_VALID_SEC = 24 * 3600;
export const MAX_ACTIVE_RULES = 10;
/** Each backtest reads up to 30 days of Hyperliquid candles. */
export const MAX_BACKTESTS_PER_HOUR = 30;

const accountId = z.string().regex(/^[a-z0-9._-]{2,64}$/, "bad account");
const nearKey = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/, "bad key");
const signInBody = z.object({
  account: accountId,
  signer: nearKey,
  issuedAt: z.number().int(),
  /** NEP-413 signature (base64) and its 32-byte nonce (base64). */
  signature: z.string().min(80).max(100),
  nonce: z.string().min(40).max(48),
});
const backtestBody = z.object({ rule: z.unknown(), days: z.number().int().min(1).max(30).default(7) });
const ruleBody = z.object({ rule: z.unknown() });
const statusBody = z.object({
  status: z.enum(["enabled", "paused", "stopped"]),
  /** Enabling: the rule the app showed, and the passkey's approval of exactly that rule. */
  ruleHash: z.string().optional(),
  approval: z.unknown().optional(),
});
const grantBody = z.object({
  /** USDC (raw, 6 decimals) the session may move per day. */
  dailyLimit: z.string().regex(/^\d+$/).default("500000000"),
  validDays: z.number().int().min(1).max(7).default(7),
  /** The key the app generated, and the key itself sealed to the executor (seal v2). */
  sessionKey: nearKey,
  sealedKey: z.string().regex(/^v2\.[A-Za-z0-9_-]{100,600}$/, "seal the key to the executor with the current app"),
});
const followBody = z.object({ leader: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a leader is a Hyperliquid address"), settings: followSettingsSchema, approval: z.unknown().optional() });

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

/** An account's rule, as its Autopilot session may run it: within the account contract's leverage cap. */
function parseSessionRule(raw: unknown): { ok: true; rule: Rule } | { ok: false; error: string } {
  const rule = ruleSchema.safeParse(raw);
  if (!rule.success) return { ok: false, error: issues(rule.error) };
  const problem = sessionLeverageProblem(rule.data, SESSION_MAX_LEVERAGE);
  return problem ? { ok: false, error: `size.leverage: ${problem}` } : { ok: true, rule: rule.data };
}

function ruleJson(r: StoredRule) {
  return { id: r.id, owner: r.owner, rule: r.rule, ruleHash: r.ruleHash, status: r.status, statusReason: r.statusReason, route: r.route, backtestId: r.backtestId, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

export function autopilotRoutes(d: AutopilotRouteDeps) {
  const now = d.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  type Vars = { Variables: { user: string; token: string } };
  const app = new Hono<Vars>();
  const auth = userAuth(d.sessionSecret, d.isRevoked, d.keys, now);
  const backtestLimit = rateLimit<Vars>(MAX_BACKTESTS_PER_HOUR, 3_600_000, (c) => `account:${c.get("user")}`, now);

  app.post("/auth/session", async (c) => {
    const body = signInBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    try {
      const { account, signer, expiresAt } = await d.keys.verify(body.data, nowSec());
      return c.json({ token: issueUserToken(d.sessionSecret, account, signer, expiresAt), account, expiresAt });
    } catch (e) {
      if (e instanceof SignInError) return c.json({ error: e.message }, 401);
      if (e instanceof ChainUnavailableError) return c.json({ error: "could not check the account on chain; try again" }, 503);
      throw e;
    }
  });

  app.post("/auth/session/revoke", auth, async (c) => {
    const token = c.get("token");
    const expiry = Number(Buffer.from(token.split(".")[0] ?? "", "base64url").toString().split(".")[2] ?? 0);
    await d.revoke(tokenHash(token), expiry);
    return c.json({ ok: true });
  });

  // Public: what Autopilot can trade (Hyperliquid perps on this network) and anyone's track record.
  app.get("/autopilot/markets", async (c) => {
    const markets = await d.service.markets();
    return c.json({ markets: markets.map((m) => ({ index: m.index, symbol: m.symbol, maxLeverage: m.maxLeverage, szDecimals: m.szDecimals, markPx: m.markPx })) });
  });
  // Hyperliquid for the app's ticket and portfolio: markets with marks and funding, an account's
  // Hyperliquid address (its own Chain Signatures key) with positions, and the leaders to copy.
  app.get("/hyperliquid/markets", async (c) => c.json({ network: d.hyperliquid.network, markets: await d.service.markets() }));
  app.get("/hyperliquid/accounts/:account", async (c) => {
    const account = accountId.safeParse(c.req.param("account"));
    if (!account.success) return c.json({ error: "bad account" }, 400);
    const address = await hyperliquidAddressOf(d.view, d.signer, account.data).catch(() => null);
    if (!address) return c.json({ error: "could not derive the account's Hyperliquid address; try again" }, 503);
    const [state, orders] = await Promise.all([d.hyperliquid.accountState(address).catch(() => null), d.hyperliquid.openOrders(address).catch(() => [])]);
    return c.json({ network: d.hyperliquid.network, address, state, orders });
  });
  app.get("/hyperliquid/accounts/:account/fills", async (c) => {
    const account = accountId.safeParse(c.req.param("account"));
    if (!account.success) return c.json({ error: "bad account" }, 400);
    const address = await hyperliquidAddressOf(d.view, d.signer, account.data).catch(() => null);
    if (!address) return c.json({ error: "could not derive the account's Hyperliquid address; try again" }, 503);
    return c.json({ address, fills: (await d.hyperliquid.fills(address).catch(() => [])).slice(0, 200) });
  });
  let leadersCache: { at: number; body: unknown } | null = null;
  app.get("/hyperliquid/leaders", async (c) => {
    if (!leadersCache || now() - leadersCache.at > 300_000) {
      const leaders = await d.hyperliquid.leaders("month", 50).catch(() => null);
      if (!leaders) return c.json({ error: "Hyperliquid's leaderboard is unavailable right now" }, 502);
      const followers = await Promise.all(leaders.map((l) => d.store.followerCount(l.address)));
      leadersCache = { at: now(), body: { source: "hyperliquid-mainnet", leaders: leaders.map((l, i) => ({ ...l, followers: followers[i] ?? 0 })) } };
    }
    return c.json(leadersCache.body);
  });
  app.get("/autopilot/performance/:owner", async (c) => {
    const owner = c.req.param("owner").toLowerCase();
    if (!/^[a-z0-9._-]{2,64}$/.test(owner)) return c.json({ error: "bad account" }, 400);
    const trades = await d.store.closedTrades({ owner });
    return c.json({ owner, stats: stats(trades), equity: equityCurve(trades), followers: await d.store.followerCount(owner) });
  });

  app.post("/autopilot/backtests", auth, backtestLimit, async (c) => {
    const body = backtestBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const rule = parseSessionRule(body.data.rule);
    if (!rule.ok) return c.json({ error: rule.error }, 400);
    const result = await d.service.backtest(rule.rule, body.data.days, nowSec()).catch((e: Error) => e);
    if (result instanceof Error) return c.json({ error: result.message }, 422);
    const id = await d.store.saveBacktest(c.get("user"), rule.rule, result);
    return c.json({ id, ruleHash: ruleHash(rule.rule), result });
  });

  app.get("/autopilot/rules", auth, async (c) => c.json({ rules: (await d.store.rulesOf(c.get("user"))).map(ruleJson) }));

  app.post("/autopilot/rules", auth, async (c) => {
    const body = ruleBody.safeParse(await c.req.json().catch(() => null));
    const rule = parseSessionRule(body.success ? body.data.rule : undefined);
    if (!rule.ok) return c.json({ error: rule.error }, 400);
    if (!(await d.service.market(rule.rule.market))) return c.json({ error: `Hyperliquid has no ${rule.rule.market} perp on this network` }, 400);
    if ((await d.store.rulesOf(c.get("user"))).length >= MAX_ACTIVE_RULES * 2) return c.json({ error: "too many rules; stop some first" }, 409);
    const created = await d.store.createRule(c.get("user"), rule.rule, "session");
    await d.store.addAudit(c.get("user"), "rule_created", { rule: rule.rule }, created.id);
    return c.json({ rule: ruleJson(created) }, 201);
  });

  const owned = async (id: number, user: string) => {
    const r = await d.store.rule(id);
    return r && r.owner === user.toLowerCase() ? r : null;
  };

  app.get("/autopilot/rules/:id", auth, async (c) => {
    const r = await owned(Number(c.req.param("id")), c.get("user"));
    if (!r) return c.json({ error: "no such rule" }, 404);
    return c.json(await ruleDetail(d, r));
  });

  app.put("/autopilot/rules/:id", auth, async (c) => {
    const body = ruleBody.safeParse(await c.req.json().catch(() => null));
    const rule = parseSessionRule(body.success ? body.data.rule : undefined);
    if (!rule.ok) return c.json({ error: rule.error }, 400);
    const updated = await d.store.updateRule(Number(c.req.param("id")), c.get("user"), rule.rule);
    if (!updated) return c.json({ error: "pause the rule before editing it" }, 409);
    await d.store.addAudit(c.get("user"), "rule_edited", { rule: rule.rule }, updated.id);
    return c.json({ rule: ruleJson(updated) });
  });

  app.post("/autopilot/rules/:id/status", auth, async (c) => {
    const body = statusBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const r = await owned(Number(c.req.param("id")), c.get("user"));
    if (!r) return c.json({ error: "no such rule" }, 404);
    // Enabling is checked against the rule as stored: an edit since the app showed it voids the approval.
    const approve = async (): Promise<{ body: unknown; status: 403 | 409 | 503 } | null> => {
      if (body.data.ruleHash !== undefined && body.data.ruleHash.toLowerCase() !== r.ruleHash.toLowerCase()) {
        return { body: { error: "this rule changed since you opened it; reload it and try again" }, status: 409 };
      }
      return d.approvals.check(c.get("user"), ownerRequests.enableRule(r.id, r.ruleHash), body.data.approval);
    };
    return setRuleStatus(d, r, body.data.status, c.get("user"), nowSec(), (body2, status) => c.json(body2, status), approve);
  });

  // Grants: Autopilot's own session on the account, Hyperliquid orders only, with a daily cap.
  app.get("/autopilot/grant/seal-key", (c) => (d.sealPublicKey ? c.json({ publicKey: d.sealPublicKey }) : c.json({ error: "Autopilot is not configured on this server" }, 503)));
  app.get("/autopilot/grant", auth, async (c) => {
    const g = await d.store.grant(c.get("user"));
    return c.json({ grant: g ? { sessionKey: g.sessionKey, status: g.status, validUntil: g.validUntil, dailyLimit: g.dailyLimit.toString(), nextSessionKey: g.nextSessionKey } : null });
  });

  app.post("/autopilot/grant", auth, async (c) => {
    if (!d.sealPublicKey) return c.json({ error: "Autopilot is not configured on this server" }, 503);
    const body = grantBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const user = c.get("user");
    const sessionKey = body.data.sessionKey;
    // The box cannot be opened here; its header says which executor key it was sealed to.
    if (boxKeyId(body.data.sealedKey) !== (await sealKeyId(d.sealPublicKey))) return c.json({ error: "the key is sealed to another Autopilot key; reload the app and try again" }, 400);
    // An active grant keeps trading until this key is on chain, so asking again never pauses rules.
    const requested = await d.store.requestGrant(user, sessionKey, body.data.sealedKey, nowSec());
    if (!requested) return c.json({ error: "this key belongs to another account's grant" }, 409);
    await d.store.addAudit(user, "grant_requested", requested.replaces ? { sessionKey, replaces: requested.replaces } : { sessionKey });
    // The account adds this session with one passkey prompt (an add_session owner request); only
    // the executor can open the key.
    return c.json({
      session: {
        public_key: sessionKey,
        label: AUTOPILOT_LABEL,
        scope: { outcomes: false, perps: false, hyperliquid: true },
        expires_at: nowSec() + body.data.validDays * 86_400,
        daily_limit: body.data.dailyLimit,
        gas_key: true,
      },
    });
  });

  app.post("/autopilot/grant/confirm", auth, async (c) => {
    const user = c.get("user");
    const g = await d.store.grant(user);
    if (!g) return c.json({ error: "request a grant first" }, 404);
    // The newest requested key: a waiting replacement, or the grant's own key.
    const sessionKey = g.nextSessionKey ?? g.sessionKey;
    let session: Awaited<ReturnType<SessionReader>>;
    let key: Awaited<ReturnType<AccessKeyReader>>;
    try {
      [session, key] = await Promise.all([d.sessions(user, sessionKey), d.accessKey(user, sessionKey)]);
    } catch {
      return c.json({ error: "could not check the account on chain; try again" }, 503);
    }
    if (!session || session.expires_at <= nowSec()) return c.json({ error: "the session is not active on the account yet" }, 409);
    if (session.label !== AUTOPILOT_LABEL || !session.scope.hyperliquid || session.scope.outcomes || session.scope.perps) {
      return c.json({ error: "the session is not an Autopilot session; reload the app and grant again" }, 409);
    }
    // The key must be the account's own function-call key for session_call, so every order passes the contract's guard.
    if (!key || key.kind !== "function_call" || key.receiverId !== user || !key.methodNames.includes("session_call")) {
      return c.json({ error: "the session key is not limited to the account's guarded session calls" }, 409);
    }
    const dailyLimit = BigInt(session.daily_limit);
    if (!(await d.store.activateGrant(user, sessionKey, session.expires_at, dailyLimit))) return c.json({ error: "a newer grant was requested; try again" }, 409);
    await d.store.addAudit(user, "grant_active", { sessionKey, validUntil: session.expires_at, dailyLimit: dailyLimit.toString() });
    return c.json({ grant: { sessionKey, status: "active", validUntil: session.expires_at, dailyLimit: dailyLimit.toString(), nextSessionKey: null } });
  });

  // Copy-trading.
  app.get("/follows", auth, async (c) => c.json({ follows: await d.store.follows({ follower: c.get("user") }) }));
  app.post("/follows", auth, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { settings?: unknown } | null;
    const body = followBody.safeParse(raw);
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    if (body.data.settings.maxLeverage > SESSION_MAX_LEVERAGE) return c.json({ error: `settings.maxLeverage: copies open from your account at up to ${SESSION_MAX_LEVERAGE}x` }, 400);
    const user = c.get("user");
    if (body.data.leader.toLowerCase() === user) return c.json({ error: "you cannot follow yourself" }, 400);
    const g = await d.store.grant(user);
    if (g?.status !== "active") return c.json({ error: "grant Autopilot access first: copies trade through the same Hyperliquid-only session" }, 409);
    // The approval covers the settings exactly as sent; what is stored follows from them.
    const refused = await d.approvals.check(user, ownerRequests.follow(body.data.leader, raw?.settings), body.data.approval);
    if (refused) return c.json(refused.body, refused.status);
    const f = await d.store.upsertFollow(user, body.data.leader, body.data.settings);
    await d.store.addAudit(user, "follow_started", { leader: f.leader, settings: f.settings }, null, f.id);
    return c.json({ follow: f }, 201);
  });
  app.post("/follows/:id/status", auth, async (c) => {
    const body = z.object({ status: z.enum(["active", "paused", "stopped"]), approval: z.unknown().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    // Resuming copies trades again, so it needs the passkey; pausing and stopping do not.
    if (body.data.status === "active") {
      const refused = await d.approvals.check(c.get("user"), ownerRequests.resumeFollow(Number(c.req.param("id"))), body.data.approval);
      if (refused) return c.json(refused.body, refused.status);
    }
    const ok = await d.store.setFollowStatus(Number(c.req.param("id")), c.get("user"), body.data.status);
    if (!ok) return c.json({ error: "no such follow" }, 404);
    await d.store.addAudit(c.get("user"), `follow_${body.data.status}`, {}, null, Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  return app;
}

/** Rule detail: the rule, its positions, performance and recent audit log. */
export async function ruleDetail(d: Pick<AutopilotRouteDeps, "store">, r: StoredRule) {
  const [positions, trades, audit] = await Promise.all([d.store.positions({ ruleId: r.id }), d.store.closedTrades({ ruleId: r.id }), d.store.audit({ ruleId: r.id }, 50)]);
  const backtest = r.backtestId ? await d.store.backtest(r.backtestId) : null;
  return {
    rule: ruleJson(r),
    stats: stats(trades),
    equity: equityCurve(trades),
    positions,
    audit,
    backtest: backtest ? { id: backtest.id, createdAt: backtest.createdAt.toISOString(), stats: backtest.result.stats, warnings: backtest.result.warnings } : null,
  };
}

/**
 * Enables, pauses or stops a rule. Enabling needs a recent backtest of exactly this rule and, for
 * accounts, an active grant; `approve` runs once those hold (the passkey's approval for accounts).
 */
export async function setRuleStatus<R>(
  d: Pick<AutopilotRouteDeps, "store" | "service">,
  r: StoredRule,
  status: "enabled" | "paused" | "stopped",
  by: string,
  nowSec: number,
  reply: (body: unknown, status: 200 | 403 | 409 | 503) => R,
  approve?: () => Promise<{ body: unknown; status: 403 | 409 | 503 } | null>,
): Promise<R> {
  if (status === "enabled") {
    const kill = await d.store.killSwitch();
    if (kill.engaged) return reply({ error: `Autopilot is halted: ${kill.reason ?? "kill switch engaged"}` }, 409);
    const bt = await d.store.recentBacktest(r.owner, r.ruleHash, BACKTEST_VALID_SEC);
    if (!bt) return reply({ error: "backtest this exact rule first (backtests count for 24 hours)" }, 409);
    if (!(await d.service.trendFor(r.rule.trend))) return reply({ error: `${r.rule.trend} is not a listed trend yet` }, 409);
    if (r.route === "session") {
      const g = await d.store.grant(r.owner);
      if (g?.status !== "active" || g.validUntil < nowSec + 3600) return reply({ error: "grant Autopilot access to your account first" }, 409);
    }
    const enabledCount = (await d.store.rulesOf(r.owner)).filter((x) => x.status === "enabled").length;
    if (r.status !== "enabled" && enabledCount >= MAX_ACTIVE_RULES) return reply({ error: `at most ${MAX_ACTIVE_RULES} rules run at once` }, 409);
    const refused = approve ? await approve() : null;
    if (refused) return reply(refused.body, refused.status);
    const updated = await d.store.setStatus(r.id, "enabled", null, bt.id);
    await d.store.addAudit(r.owner, "rule_enabled", { by, backtestId: bt.id, backtest: bt.result.stats }, r.id);
    return reply({ rule: ruleJson(updated!) }, 200);
  }
  const updated = await d.store.setStatus(r.id, status, status === "stopped" ? "stopped by owner" : "paused by owner");
  await d.store.addAudit(r.owner, `rule_${status}`, { by }, r.id);
  return reply({ rule: ruleJson(updated!) }, 200);
}

/** Admin routes for the Tredio bot's rules and the kill switch. */
export function autopilotAdminRoutes(d: AutopilotRouteDeps) {
  const app = new Hono<{ Variables: { admin: string } }>();
  const nowSec = () => Math.floor((d.now ?? Date.now)() / 1000);
  app.get("/autopilot", async (c) => {
    const [kill, enabled] = await Promise.all([d.store.killSwitch(), d.store.enabledRules()]);
    return c.json({ kill, enabled: enabled.map(ruleJson), recent: await d.store.audit({}, 50), bot: d.botAccount ?? null });
  });
  app.post("/autopilot/kill", async (c) => {
    const body = z.object({ engaged: z.boolean(), reason: z.string().max(200).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    await d.store.setKillSwitch(body.data.engaged, body.data.reason ?? null, c.get("admin"));
    await d.store.addAudit(c.get("admin"), body.data.engaged ? "kill_engaged" : "kill_released", { reason: body.data.reason ?? null });
    d.log.warn({ by: c.get("admin"), engaged: body.data.engaged }, "autopilot kill switch");
    return c.json({ kill: await d.store.killSwitch() });
  });
  app.post("/autopilot/bot/rules", async (c) => {
    if (!d.botAccount) return c.json({ error: "AUTOPILOT_BOT_ACCOUNT is not set" }, 503);
    const body = ruleBody.safeParse(await c.req.json().catch(() => null));
    const rule = ruleSchema.safeParse(body.success ? body.data.rule : undefined);
    if (!rule.success) return c.json({ error: issues(rule.error) }, 400);
    const created = await d.store.createRule(d.botAccount, rule.data as Rule, "api");
    await d.store.addAudit(d.botAccount, "rule_created", { by: c.get("admin"), rule: rule.data }, created.id);
    return c.json({ rule: ruleJson(created) }, 201);
  });
  app.post("/autopilot/bot/backtests", async (c) => {
    if (!d.botAccount) return c.json({ error: "AUTOPILOT_BOT_ACCOUNT is not set" }, 503);
    const body = backtestBody.safeParse(await c.req.json().catch(() => null));
    const rule = ruleSchema.safeParse(body.success ? body.data.rule : undefined);
    if (!body.success || !rule.success) return c.json({ error: "bad rule" }, 400);
    const result = await d.service.backtest(rule.data, body.data.days, nowSec()).catch((e: Error) => e);
    if (result instanceof Error) return c.json({ error: result.message }, 422);
    return c.json({ id: await d.store.saveBacktest(d.botAccount, rule.data, result), result });
  });
  app.post("/autopilot/bot/rules/:id/status", async (c) => {
    const body = statusBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issues(body.error) }, 400);
    const r = await d.store.rule(Number(c.req.param("id")));
    if (!r || r.route !== "api") return c.json({ error: "no such bot rule" }, 404);
    return setRuleStatus(d, r, body.data.status, c.get("admin"), nowSec(), (b, s) => c.json(b, s));
  });
  app.get("/autopilot/bot/rules/:id", async (c) => {
    const r = await d.store.rule(Number(c.req.param("id")));
    if (!r || r.route !== "api") return c.json({ error: "no such bot rule" }, 404);
    return c.json(await ruleDetail(d, r));
  });
  return app;
}
