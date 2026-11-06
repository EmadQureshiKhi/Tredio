"use client";
import { useQuery } from "@tanstack/react-query";
import { system, trends } from "@/lib/api";
import { view } from "@/lib/chain/client";
import { DEPLOYMENT, USDC_DECIMALS } from "@/lib/config";

/** Shared queries: one cache entry per resource, refreshed at the pace its data moves. */

export function useTrends() {
  return useQuery({ queryKey: ["trends"], queryFn: () => trends.list(), refetchInterval: 15_000 });
}

export function useTrend(identifier: string) {
  return useQuery({ queryKey: ["trend", identifier], queryFn: () => trends.get(identifier), refetchInterval: 15_000 });
}

export function useUpcoming() {
  return useQuery({ queryKey: ["upcoming"], queryFn: () => trends.upcoming(), refetchInterval: 60_000 });
}

/** USDC (6 decimals) an account holds on NEAR. */
export async function readUsdc(account: string): Promise<bigint> {
  return BigInt((await view<string | null>(DEPLOYMENT.contracts.usdc, "ft_balance_of", { account_id: account })) ?? "0");
}

/** The account's USDC, refreshed every few seconds while signed in. */
export function useUsdcBalance(account: string | undefined) {
  return useQuery({
    queryKey: ["usdc", account],
    enabled: Boolean(account),
    refetchInterval: 4_000,
    queryFn: async () => {
      const raw = await readUsdc(account!);
      return { raw, value: Number(raw) / 10 ** USDC_DECIMALS };
    },
  });
}

export function useSystemStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => system.status(), refetchInterval: 30_000, retry: false });
}
