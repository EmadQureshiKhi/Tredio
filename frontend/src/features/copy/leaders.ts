"use client";
import { APP_URL as HL_APP_URL } from "@tredio/hyperliquid";
import { useMemo } from "react";
import type { HlLeader } from "@/lib/api";
import { HL_NETWORK } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { BOT_ACCOUNT, useHlAddress, useHlLeaders } from "@/features/autopilot/shared/data";

/**
 * Who a copy leader is. Copies follow a Hyperliquid address: the Tredio bot's (its NEAR account's
 * Chain Signatures address), or a trader on Hyperliquid mainnet's public leaderboard (testnet has
 * none, so a testnet follower copies their mainnet positions into its own testnet account).
 */
export type DirectoryLeader = HlLeader & { followers: number };

export function useLeaderDirectory() {
  const board = useHlLeaders();
  const bot = useHlAddress(BOT_ACCOUNT);
  return useMemo(() => {
    const leaders = board.data?.leaders ?? [];
    const botAddress = bot.data ?? null;
    const byAddress = new Map(leaders.map((l) => [l.address.toLowerCase(), l]));
    const isBot = (address: string | null | undefined) => Boolean(address) && botAddress !== null && address!.toLowerCase() === botAddress;
    const leader = (address: string) => byAddress.get(address.toLowerCase()) ?? null;
    return {
      loading: board.isLoading || (BOT_ACCOUNT !== null && bot.isLoading),
      error: board.error,
      botAddress,
      isBot,
      leader,
      name: (address: string) => (isBot(address) ? "Tredio bot" : (leader(address)?.displayName ?? shortAddress(address))),
      /** The leader on Hyperliquid's explorer: the bot trades on this network, leaderboard traders on mainnet. */
      href: (address: string) => `${HL_APP_URL[isBot(address) ? HL_NETWORK : "mainnet"]}/explorer/address/${address}`,
      /** The bot, then the leaderboard's best by monthly profit. */
      featured: (limit = 9): Array<{ address: string; leader: DirectoryLeader | null }> => [
        ...(botAddress ? [{ address: botAddress, leader: null }] : []),
        ...leaders.slice(0, limit).map((l) => ({ address: l.address.toLowerCase(), leader: l })),
      ],
    };
  }, [board.data, board.isLoading, board.error, bot.data, bot.isLoading]);
}
