import { scrub } from "../errors";
import { REJECTED_KEY_MS } from "../budget";
import { BudgetError, type Fetch, fetchJson, HttpError } from "../sources/http";
import type { ReviewEvidence } from "./nearai";

/**
 * Language-model providers behind one call that returns JSON matching a schema. Providers are
 * tried in order and the first that answers wins, so an exhausted or failing model falls back to
 * the next one. Tredio's cascade is NEAR AI Cloud's verifiable models (see nearai.ts), each answer
 * carrying the evidence that it came from an attested enclave.
 */

/** The JSON Schema subset every provider accepts: objects, arrays, strings, numbers, booleans, enums. */
export type Schema =
  | { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false; description?: string }
  | { type: "array"; items: Schema; minItems?: number; maxItems?: number; description?: string }
  | { type: "string" | "number" | "integer" | "boolean"; enum?: string[]; description?: string; nullable?: boolean };

export interface Provider {
  readonly name: string;
  generate(system: string, user: string, schema: Schema, schemaName: string): Promise<{ value: unknown; evidence?: ReviewEvidence }>;
}

/** Strict JSON Schema for OpenAI structured outputs: nullable becomes a type union. */
export interface AiResult<T> {
  value: T;
  provider: string;
  /** Verification evidence when the provider supplies it (NEAR AI Cloud). */
  evidence?: ReviewEvidence;
}

/** A daily allowance of provider requests (a KeyRing): `take` reserves one, or returns null when spent. */
export interface AiBudget {
  take(): Promise<object | null>;
}

/**
 * How long a provider rests after an HTTP refusal: a rejected key (401) as long as a rejected source
 * key, billing or quota for an hour, a plain throttle for a minute, and anything else not at all.
 */
export function benchMs(e: HttpError): number {
  if (e.status === 401) return REJECTED_KEY_MS;
  if (e.status === 402 || e.status === 403) return 3_600_000;
  if (e.status === 429) return /quota|billing|insufficient|suspend/i.test(e.body) ? 3_600_000 : 60_000;
  return 0;
}

/** One provider's requests since the process started, for the admin system view. */
export interface AiProviderStats {
  name: string;
  requests: number;
  ok: number;
  failures: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  /** Scrubbed of URLs and keys. */
  lastError: string | null;
  /** Resting after a billing, quota or key refusal until this time; null when available. */
  benchedUntil: number | null;
}

export class Ai {
  /** Providers that refused for billing or quota, benched until this time. */
  private readonly benched = new Map<string, number>();
  private readonly stats = new Map<string, Omit<AiProviderStats, "benchedUntil">>();

  constructor(
    readonly providers: readonly Provider[],
    private readonly warn: (message: string, fields: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now,
    /** Every provider request, fallbacks included, spends one; none is made once it is spent. */
    private readonly budget: AiBudget | null = null,
  ) {}

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  /** Each provider in fallback order: its requests, last success and last error, and whether it rests. */
  report(): AiProviderStats[] {
    const now = this.now();
    return this.providers.map((p) => {
      const s = this.statsOf(p.name);
      const until = this.benched.get(p.name) ?? 0;
      return { ...s, benchedUntil: until > now ? until : null };
    });
  }

  private statsOf(name: string) {
    let s = this.stats.get(name);
    if (!s) {
      s = { name, requests: 0, ok: 0, failures: 0, lastOkAt: null, lastErrorAt: null, lastError: null };
      this.stats.set(name, s);
    }
    return s;
  }

  /**
   * The first provider's answer that `parse` accepts. Throws when every provider fails, and
   * BudgetError when the day's AI budget is spent.
   */
  async json<T>(system: string, user: string, schema: Schema, schemaName: string, parse: (v: unknown) => T): Promise<AiResult<T>> {
    const errors: string[] = [];
    for (const p of this.providers) {
      if ((this.benched.get(p.name) ?? 0) > this.now()) continue;
      if (this.budget && !(await this.budget.take())) throw new BudgetError("ai");
      const stats = this.statsOf(p.name);
      stats.requests++;
      try {
        const out = await p.generate(system, user, schema, schemaName);
        const value = parse(out.value);
        stats.ok++;
        stats.lastOkAt = this.now();
        return { value, provider: p.name, evidence: out.evidence };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        stats.failures++;
        stats.lastErrorAt = this.now();
        stats.lastError = scrub(message, 200);
        errors.push(`${p.name}: ${message.slice(0, 200)}`);
        // Billing and quota refusals last, and a rejected key does not heal by itself: rest the
        // provider instead of spending a round trip and a unit of the day's budget each time.
        if (e instanceof HttpError) {
          const bench = benchMs(e);
          if (bench > 0) this.benched.set(p.name, this.now() + bench);
        }
        this.warn("ai provider failed", { provider: p.name, error: message.slice(0, 200) });
      }
    }
    throw new Error(`every AI provider failed: ${errors.join(" | ") || "none configured"}`);
  }
}
