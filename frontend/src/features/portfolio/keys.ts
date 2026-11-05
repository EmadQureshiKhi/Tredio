/** The root of every portfolio query for an account, so one invalidation refreshes them all. */
export const portfolioKey = (address: string | undefined) => ["portfolio", address?.toLowerCase()] as const;
