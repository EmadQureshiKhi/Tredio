"use client";
import { useQuery } from "@tanstack/react-query";
import type { SystemStatus } from "@/lib/api";
import { BACKEND_URL } from "@/lib/config";

/**
 * GET /v1/status?soft=1: the full status with a 200 even when something is down (plain requests get
 * 503 then, for uptime monitors), so a degraded system reads as data and logs no failed request;
 * only an unreachable backend errors.
 */
export async function fetchStatus(signal?: AbortSignal): Promise<SystemStatus> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/v1/status?soft=1`, { headers: { accept: "application/json" }, signal });
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

/** Each Tredio contract's name as the status page shows it (the API reports the deployment's role keys). */
export const CONTRACT_LABELS: Record<string, string> = {
  usdc: "USDC",
  registry: "Registry",
  outcomes: "Outcomes",
  book: "Order book",
  perps: "Perps",
  curation: "Curation",
  coins: "Trend coins",
  accounts: "Accounts",
};

/** What each service does, in plain words. */
export const SERVICES: Record<string, ServiceInfo> = {
  keeper: { label: "Keeper", body: "Opens and lists each new Up/Down series, settles expired ones, keeps perp funding current, liquidates unsafe positions, retires quiet trends and graduates full curves." },
  "market-maker": { label: "Market maker", body: "Quotes Up and Down on the order book for every listed series, so there is always a price to buy or sell at." },
  relayer: { label: "Relayer", body: "Creates passkey accounts, relays passkey-signed requests and refills each trading session's gas key, so nobody needs to hold NEAR to trade." },
  autopilot: { label: "Autopilot", body: "Runs Autopilot rules and copy trading on Hyperliquid around the clock, through each account's own guarded session." },
  oracle: { label: "Oracle", body: "Measures attention from every source and writes each trend's index, with Hyperliquid marks, to the registry in signed reports." },
  indexer: { label: "Indexer", body: "Reads Tredio's events from every NEAR block into the history behind portfolios, leaderboards and trend stats." },
  topup: { label: "Top-up", body: "Keeps every Tredio service account that sends transactions funded from one treasury, so the oracle, keeper, relayer and market maker never stall." },
};

export const serviceInfo = (name: string): ServiceInfo =>
  SERVICES[name] ?? { label: name.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()), body: "A Tredio service." };
