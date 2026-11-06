/**
 * The Tredio bot: the NEAR account whose public Autopilot rules trade Hyperliquid, the natural first
 * leader to follow (backend AUTOPILOT_BOT_ACCOUNT). Unset, the app shows no bot.
 */
export const BOT_ACCOUNT: string | null = process.env.NEXT_PUBLIC_TREDIO_BOT_ACCOUNT?.trim().toLowerCase() || null;

export const isBot = (account: string | null | undefined) => Boolean(account) && BOT_ACCOUNT !== null && account!.toLowerCase() === BOT_ACCOUNT;
