import { z } from "zod";
import { autopilotMarketProblem, isAutopilotMarket } from "./markets";

/**
 * An Autopilot rule: when a trend's attention moves enough (and, optionally, smart money agrees),
 * open a leveraged position on an asset perp market, then exit on a stop, a take-profit or a time limit,
 * inside position, daily-loss and cooldown limits. The same rule drives the backtest and live
 * trading, so a backtest shows exactly what the rule would have done.
 */

export const ruleSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    /** Asset perp market symbol, one of AUTOPILOT_MARKETS, for example BTC (a string still: rules stored before the list was this short may name others). */
    market: z.string().refine((m): boolean => isAutopilotMarket(m), { error: (iss) => autopilotMarketProblem(String(iss.input)) ?? "not an Autopilot market" }),
    /** Trend identifier whose attention index drives the rule, for example crypto:btc. */
    trend: z.string().regex(/^[a-z0-9:._-]{1,64}$/),
    entry: z.object({
      /** Attention change in percent over the window: 30 means up at least 30%, -20 down at least 20%. */
      attentionChangePct: z.number().min(-90).max(1000).refine((v) => v !== 0, "a change of 0% would always fire"),
      windowMin: z.number().int().min(5).max(7 * 24 * 60),
      /** Only act while the index is at or above this many points. */
      minIndex: z.number().min(0).max(100).default(0),
      /** Nansen smart-money net flow over 24 hours must agree: buying is a net inflow, selling an outflow. */
      smartMoney: z.enum(["any", "buying", "selling"]).default("any"),
      side: z.enum(["long", "short"]),
    }),
    size: z.object({
      /** USDC posted as margin per trade. */
      marginUsdc: z.number().positive().max(1_000_000),
      leverage: z.number().min(1).max(20),
    }),
    exits: z.object({
      stopLossPct: z.number().positive().max(90),
      takeProfitPct: z.number().positive().max(1000),
      /** Close after this long whatever the price did; 0 for no limit. */
      maxHoldMin: z.number().int().min(0).max(30 * 24 * 60).default(0),
    }),
    limits: z.object({
      /** Largest position notional (margin times leverage) in USDC. */
      maxPositionUsdc: z.number().positive(),
      /** Stop opening positions for the rest of the UTC day once realized losses reach this. */
      maxDailyLossUsdc: z.number().positive(),
      /** Wait this long after a position closes before opening the next. */
      cooldownMin: z.number().int().min(0).max(7 * 24 * 60).default(30),
    }),
  })
  .superRefine((r, ctx) => {
    const liquidation = 100 / r.size.leverage;
    if (r.exits.stopLossPct >= liquidation) {
      ctx.addIssue({
        code: "custom",
        path: ["exits", "stopLossPct"],
        message: `a ${r.exits.stopLossPct}% stop at ${r.size.leverage}x is beyond liquidation (about ${liquidation.toFixed(1)}%); lower the stop or the leverage`,
      });
    }
    if (r.size.marginUsdc * r.size.leverage > r.limits.maxPositionUsdc) {
      ctx.addIssue({ code: "custom", path: ["limits", "maxPositionUsdc"], message: "margin times leverage is above the maximum position" });
    }
  });

export type Rule = z.infer<typeof ruleSchema>;
export type RuleInput = z.input<typeof ruleSchema>;
export type Side = "long" | "short";

/**
 * Why an account's rule opens at more leverage than its session may, or null. Accounts trade through
 * their Autopilot session key, and the account's order guard refuses session openings above its cap
 * (10x on testnet). The Tredio bot trades from its own account, so its rules go up to the market's
 * own limit.
 */
export function sessionLeverageProblem(rule: Pick<Rule, "size">, sessionMaxLeverage: number): string | null {
  return rule.size.leverage > sessionMaxLeverage ? `Autopilot opens positions from your account at up to ${sessionMaxLeverage}x; lower the leverage` : null;
}
