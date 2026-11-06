import { DEFAULT_COPY_SLIPPAGE_PCT, type FollowSettings, MAX_COPY_SLIPPAGE_PCT } from "@tredio/autopilot";

/**
 * The follow form: strings while typing, FollowSettings once valid. The limits are the backend's
 * (followSettingsSchema, and leverage within the session's cap since copies trade through it), and
 * every setting is sent explicitly, so the passkey approves exactly what the server stores.
 */

/** Copies open through Autopilot's session, whose account contract caps Hyperliquid leverage at 10x. */
export const COPY_MAX_LEVERAGE = 10;

export interface FollowForm {
  mode: "ratio" | "fixed";
  ratio: string;
  fixed: string;
  maxMargin: string;
  maxLeverage: string;
  maxDailyLoss: string;
  maxSlippage: string;
  maxOpenLoss: string;
}

export const FOLLOW_DEFAULTS: FollowForm = {
  mode: "ratio",
  ratio: "1",
  fixed: "20",
  maxMargin: "50",
  maxLeverage: "3",
  maxDailyLoss: "25",
  maxSlippage: String(DEFAULT_COPY_SLIPPAGE_PCT),
  maxOpenLoss: "20",
};

const s = (v: number) => String(Number.isInteger(v) ? v : Number(v.toFixed(4)));

export const formOf = (f: FollowSettings): FollowForm => ({
  mode: f.mode,
  ratio: s(f.ratio),
  fixed: s(f.fixedMarginUsdc),
  maxMargin: s(f.maxMarginUsdc),
  maxLeverage: s(f.maxLeverage),
  maxDailyLoss: s(f.maxDailyLossUsdc),
  maxSlippage: s(f.maxSlippagePct),
  maxOpenLoss: s(f.maxOpenLossUsdc),
});

/** The backend's follow settings rules, with the same limits. */
export function validateFollow(f: FollowForm): { settings: FollowSettings | null; errors: Partial<Record<keyof FollowForm, string>> } {
  const n = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));
  const errors: Partial<Record<keyof FollowForm, string>> = {};
  const ratio = n(f.ratio);
  const fixed = n(f.fixed);
  const maxMargin = n(f.maxMargin);
  const maxLeverage = n(f.maxLeverage);
  const maxDailyLoss = n(f.maxDailyLoss);
  const maxSlippage = n(f.maxSlippage);
  const maxOpenLoss = n(f.maxOpenLoss);
  if (f.mode === "ratio" && !(ratio > 0 && ratio <= 10)) errors.ratio = "Between 0.01 and 10";
  if (f.mode === "fixed" && !(fixed > 0 && fixed <= 1_000_000)) errors.fixed = "Fixed mode needs a margin per trade";
  if (!(maxMargin > 0 && maxMargin <= 1_000_000)) errors.maxMargin = "More than 0";
  if (!(maxLeverage >= 1 && maxLeverage <= COPY_MAX_LEVERAGE)) errors.maxLeverage = `Between 1 and ${COPY_MAX_LEVERAGE}`;
  if (!(maxDailyLoss > 0 && maxDailyLoss <= 1_000_000)) errors.maxDailyLoss = "More than 0";
  if (!(maxSlippage >= 0.05 && maxSlippage <= MAX_COPY_SLIPPAGE_PCT)) errors.maxSlippage = `Between 0.05 and ${MAX_COPY_SLIPPAGE_PCT}`;
  if (!(maxOpenLoss > 0 && maxOpenLoss <= 1_000_000)) errors.maxOpenLoss = "More than 0";
  if (f.mode === "fixed" && !errors.fixed && !errors.maxMargin && fixed > maxMargin) errors.fixed = "Above your maximum margin per position";
  if (Object.keys(errors).length) return { settings: null, errors };
  return {
    settings: {
      mode: f.mode,
      ratio: f.mode === "ratio" ? ratio : 1,
      fixedMarginUsdc: f.mode === "fixed" ? fixed : 0,
      maxMarginUsdc: maxMargin,
      maxLeverage,
      maxDailyLossUsdc: maxDailyLoss,
      maxSlippagePct: maxSlippage,
      maxOpenLossUsdc: maxOpenLoss,
    },
    errors,
  };
}
