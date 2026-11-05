"use client";
import { useMemo } from "react";
import type { CallerRow } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { BOT_ADDRESS, isBot, useLeaderboard } from "@/features/autopilot/shared/data";

/**
 * Who a trading account is: the Tredio bot, a caller who linked it (by handle), or just an
 * address. Linking is public, so this is what anyone can see.
 */
export function useLeaderDirectory() {
  const board = useLeaderboard();
  return useMemo(() => {
    const byAccount = new Map<string, CallerRow>();
    for (const c of board.data?.callers ?? []) if (c.linked_account) byAccount.set(c.linked_account.toLowerCase(), c);
    const caller = (account: string) => byAccount.get(account.toLowerCase()) ?? null;
    return {
      loading: board.isLoading,
      caller,
      name: (account: string) => (isBot(account) ? "Tredio bot" : caller(account)?.handle ? `@${caller(account)!.handle}` : shortAddress(account)),
      /** The profile page: the caller's, or the account's own record. */
      href: (account: string) => {
        const c = caller(account);
        return `/c/${c ? (c.handle ?? c.address) : account.toLowerCase()}`;
      },
      /** The bot, then linked callers with a resolved track record, by score. */
      featured: (exclude?: string | null) => {
        const seen = new Set<string>([BOT_ADDRESS]);
        const out: Array<{ account: string; caller: CallerRow | null }> = [{ account: BOT_ADDRESS, caller: null }];
        for (const c of board.data?.callers ?? []) {
          const a = c.linked_account?.toLowerCase();
          if (!a || seen.has(a) || a === exclude?.toLowerCase() || c.resolved === 0) continue;
          seen.add(a);
          out.push({ account: a, caller: c });
        }
        return out.slice(0, 7);
      },
    };
  }, [board.data, board.isLoading]);
}
