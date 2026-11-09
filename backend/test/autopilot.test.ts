import { describe, expect, test } from "bun:test";
import { autopilotMarketProblem, type RuleInput } from "@tredio/autopilot";
import type { PerpMarket } from "@tredio/hyperliquid";
import { issueUserToken } from "../src/api/user-auth";
import { type AutopilotRouteDeps, autopilotRoutes } from "../src/autopilot/routes";
import { quietLog } from "./helpers";

const SECRET = "autopilot-test-session-secret-0123456789";
const USER = "0uuser";
const NOW = 1_793_900_000_000;

const market = (symbol: string, index: number): PerpMarket =>
  ({ index, symbol, szDecimals: 2, maxLeverage: 20, markPx: 100, midPx: 100, oraclePx: 100, funding: 0, openInterest: 0, dayNtlVlm: 0, prevDayPx: 100 }) as PerpMarket;
// Hyperliquid lists more than Autopilot trades: ZEC and DOGE have no mark Tredio's oracle keeps up for the order guard.
const listed = [market("BTC", 0), market("ZEC", 1), market("ETH", 2), market("DOGE", 3)];

/** The routes with only what these tests touch: rule creation, enabling and the market list; anything else fails loudly. */
function routes() {
  const created: RuleInput[] = [];
  const deps = {
    isRevoked: async () => false,
    revoke: async () => {},
    store: {
      rulesOf: async () => [],
      rule: async (id: number) => (id === 7 ? { id, owner: USER, rule: rule("ZEC"), ruleHash: "h", status: "paused", route: "session" } : null),
      createRule: async (owner: string, rule: RuleInput, route: string) => {
        created.push(rule);
        return { id: created.length, owner, rule, ruleHash: "h", status: "draft", statusReason: null, route, backtestId: null, createdAt: new Date(NOW), updatedAt: new Date(NOW) };
      },
      addAudit: async () => {},
    },
    service: { markets: async () => listed, market: async (s: string) => listed.find((m) => m.symbol === s) ?? null },
    keys: { stillActive: async () => true },
    sessionSecret: SECRET,
    log: quietLog,
    now: () => NOW,
  } as unknown as AutopilotRouteDeps;
  return { app: autopilotRoutes(deps), created };
}

const token = issueUserToken(SECRET, USER, "ed25519:11111111111111111111111111111111", Math.floor(NOW / 1000) + 3600);
const rule = (market: string): RuleInput => ({
  name: `Long ${market}`,
  market,
  trend: "crypto:btc",
  entry: { attentionChangePct: 30, windowMin: 60, side: "long" },
  size: { marginUsdc: 20, leverage: 2 },
  exits: { stopLossPct: 5, takeProfitPct: 10 },
  limits: { maxPositionUsdc: 100, maxDailyLossUsdc: 20 },
});
const post = (app: ReturnType<typeof routes>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Autopilot markets", () => {
  test("lists only Autopilot's markets among those Hyperliquid lists", async () => {
    const res = await routes().app.request("/autopilot/markets");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { markets: Array<{ symbol: string }> }).markets.map((m) => m.symbol)).toEqual(["BTC", "ETH"]);
  });

  test("a rule on a market Hyperliquid lists but Autopilot does not trade is refused, with why", async () => {
    const { app, created } = routes();
    for (const path of ["/autopilot/rules", "/autopilot/backtests"]) {
      const res = await post(app, path, { rule: rule("ZEC") });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `market: ${autopilotMarketProblem("ZEC")}` });
    }
    expect(created).toHaveLength(0);
    const ok = await post(app, "/autopilot/rules", { rule: rule("ETH") });
    expect(ok.status).toBe(201);
    expect(created.map((r) => r.market)).toEqual(["ETH"]);
  });

  test("a rule saved on such a market before cannot be enabled again until it is edited", async () => {
    const res = await post(routes().app, "/autopilot/rules/7/status", { status: "enabled", ruleHash: "h" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `${autopilotMarketProblem("ZEC")}; edit the rule to trade one of them` });
  });
});

describe("following a signals channel", () => {
  const CHANNEL = `signals:${"c".repeat(64)}`;
  const settings = { mode: "ratio", ratio: 0.1, fixedMarginUsdc: 0, maxMarginUsdc: 50, maxLeverage: 3, maxDailyLossUsdc: 20, maxSlippagePct: 0.3, maxOpenLossUsdc: 5 };
  /** Follows with a grant and approvals that always pass, and early access that `access` decides. */
  function follows(access: boolean) {
    const saved: string[] = [];
    const statuses: string[] = [];
    const deps = {
      isRevoked: async () => false,
      store: {
        grant: async () => ({ status: "active" }),
        upsertFollow: async (_u: string, leader: string, s: unknown) => {
          saved.push(leader);
          return { id: 1, leader, settings: s };
        },
        follows: async () => [{ id: 1, leader: CHANNEL }],
        setFollowStatus: async (_id: number, _u: string, status: string) => {
          statuses.push(status);
          return true;
        },
        addAudit: async () => {},
      },
      approvals: { check: async () => null },
      signalAccess: async (follower: string, leader: string) => access && follower === USER && leader === CHANNEL,
      keys: { stillActive: async () => true },
      sessionSecret: SECRET,
      log: quietLog,
      now: () => NOW,
    } as unknown as AutopilotRouteDeps;
    return { app: autopilotRoutes(deps), saved, statuses };
  }

  test("a follow of a channel needs early access; a Hyperliquid address does not", async () => {
    const without = follows(false);
    const refused = await post(without.app, "/follows", { leader: CHANNEL, settings });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: "buy early access to these signals first: Autopilot copies them while it lasts" });
    expect((await post(without.app, "/follows", { leader: "0x972dac64d693f387cd089f0efcda320c71097a2c", settings })).status).toBe(201);
    expect((await post(without.app, "/follows", { leader: "signals:nothex", settings })).status).toBe(400);
    const withAccess = follows(true);
    expect((await post(withAccess.app, "/follows", { leader: CHANNEL, settings })).status).toBe(201);
    expect(withAccess.saved).toEqual([CHANNEL]);
  });

  test("resuming a channel's follow needs access again; pausing never does", async () => {
    const without = follows(false);
    expect((await post(without.app, "/follows/1/status", { status: "active" })).status).toBe(402);
    expect((await post(without.app, "/follows/1/status", { status: "paused" })).status).toBe(200);
    expect(without.statuses).toEqual(["paused"]);
    const withAccess = follows(true);
    expect((await post(withAccess.app, "/follows/1/status", { status: "active" })).status).toBe(200);
  });
});
