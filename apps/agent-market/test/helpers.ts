import { deployment } from "@tredio/contracts";
import { type ChainViews, ApiError } from "@tredio/mcp";
import { AttentionChecker, type ApiReader } from "../src/check";
import type { ApiCandidate, ApiTrend } from "../src/topic";
import live from "./fixtures/live.json";
import review from "./fixtures/review.json";

/**
 * Fixtures captured from testnet and Tredio's API on 2026-11-09: the trend list, one trend's
 * detail with its registry views, the radar, and a NEAR AI Cloud review with its real signature.
 */

export const D = deployment("testnet");
export const NOW_SEC = live.capturedAt;
export const TREND = "topic:godzilla-minus-zero.2";
export const REVIEW_HASH = review.hash;
export const trends = live.trends as unknown as ApiTrend[];
export const candidates = live.candidates.candidates as unknown as ApiCandidate[];

/** Tredio's API, answering from the fixtures; `overrides` replace or add paths. */
export function fakeApi(overrides: Record<string, unknown> = {}): ApiReader & { calls: string[] } {
  const routes: Record<string, unknown> = {
    "/v1/trends?all=1": { lastRunId: 1, trends },
    "/v1/candidates": live.candidates,
    [`/v1/trends/${encodeURIComponent(TREND)}`]: live.detail,
    [`/v1/reviews/${REVIEW_HASH}`]: review,
    ...overrides,
  };
  const calls: string[] = [];
  return {
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      const body = routes[path];
      if (body instanceof Error) throw body;
      if (body === undefined) throw new ApiError(404, "no such trend");
      return structuredClone(body) as T;
    },
  };
}

/** The registry's views over "RPC", from the fixtures. */
export function fakeChain(overrides: Partial<Record<string, unknown>> = {}): ChainViews {
  return {
    async view<T>(contract: string, method: string, args?: object): Promise<T> {
      if (contract !== D.contracts.registry) throw new Error(`unexpected contract ${contract}`);
      const id = (args as { id?: string } | undefined)?.id;
      const key = `${method}:${id}`;
      if (key in overrides) {
        const v = overrides[key];
        if (v instanceof Error) throw v;
        return structuredClone(v) as T;
      }
      if (id !== TREND) return null as T;
      if (method === "get_trend") return structuredClone(live.registry.trend) as T;
      if (method === "history") return structuredClone(live.registry.history) as T;
      throw new Error(`unexpected view ${method}`);
    },
    async rpc<T>(): Promise<T> {
      throw new Error("no rpc in tests");
    },
  };
}

export function checker(o: { api?: ApiReader; chain?: ChainViews; nowSec?: number } = {}): AttentionChecker {
  return new AttentionChecker({
    api: o.api ?? fakeApi(),
    chain: o.chain ?? fakeChain(),
    txIndex: null,
    deployment: D,
    network: "testnet",
    publicApiUrl: "https://api.tredio.bid",
    appUrl: "https://app.tredio.bid",
    now: () => (o.nowSec ?? NOW_SEC) * 1000,
  });
}
