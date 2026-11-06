"use client";
import { useQuery } from "@tanstack/react-query";
import type { SystemStatus } from "@/lib/api";
import { BACKEND_URL } from "@/lib/config";

/**
 * GET /v1/status. The backend answers 503 when anything is down but still sends the full status,
 * so a degraded system reads as data rather than an error; only an unreachable backend errors.
 */
export async function fetchStatus(signal?: AbortSignal): Promise<SystemStatus> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/v1/status`, { headers: { accept: "application/json" }, signal });
  } catch {
    throw new Error("Tredio's API is unreachable.");
  }
  const body = (await res.json().catch(() => null)) as SystemStatus | null;
  if (!body || !Array.isArray(body.services)) throw new Error(`The status check failed (${res.status}).`);
  return body;
}

export function useStatusPage() {
  return useQuery({ queryKey: ["status-page"], queryFn: ({ signal }) => fetchStatus(signal), refetchInterval: 10_000, refetchIntervalInBackground: false, retry: 1 });
}

export interface ServiceInfo {
  label: string;
  body: string;
}

/** What each service does, in plain words. */
export const SERVICES: Record<string, ServiceInfo> = {
  keeper: { label: "Keeper", body: "Opens and lists each new Up or down series, settles expired ones, keeps perp funding current, liquidates unsafe positions, retires quiet trends and graduates full curves." },
  "market-maker": { label: "Market maker", body: "Quotes UP and DOWN on the order book for every listed series, so there is always a price to buy or sell at." },
  relayer: { label: "Relayer", body: "Creates passkey accounts, relays passkey-signed requests and refills each trading session's gas key, so nobody needs to hold NEAR to trade." },
  autopilot: { label: "Autopilot", body: "Runs Autopilot rules and copy trading on Hyperliquid around the clock, through each account's own guarded session." },
  oracle: { label: "Oracle", body: "Measures attention from every source and writes each trend's index, with Hyperliquid marks, to the registry in signed reports." },
  indexer: { label: "Indexer", body: "Reads Tredio's events from every NEAR block into the history behind portfolios, leaderboards and trend stats." },
  topup: { label: "Top-up", body: "Keeps every Tredio service account that sends transactions funded from one treasury, so the oracle, keeper, relayer and market maker never stall." },
};

export const serviceInfo = (name: string): ServiceInfo =>
  SERVICES[name] ?? { label: name.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()), body: "A Tredio service." };
