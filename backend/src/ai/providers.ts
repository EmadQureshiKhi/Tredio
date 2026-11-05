import { scrub } from "../errors";
import { REJECTED_KEY_MS } from "../budget";
import { BudgetError, type Fetch, fetchJson, HttpError } from "../sources/http";

/**
 * Language-model providers behind one call that returns JSON matching a schema. Providers are
 * tried in order and the first that answers wins, so an exhausted or failing model falls back to
 * the next one (Gemini Flash, Gemini Flash Lite, then OpenAI or Kimi when funded).
 */

/** The JSON Schema subset every provider accepts: objects, arrays, strings, numbers, booleans, enums. */
export type Schema =
  | { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false; description?: string }
  | { type: "array"; items: Schema; minItems?: number; maxItems?: number; description?: string }
  | { type: "string" | "number" | "integer" | "boolean"; enum?: string[]; description?: string; nullable?: boolean };

export interface Provider {
  readonly name: string;
  generate(system: string, user: string, schema: Schema, schemaName: string): Promise<unknown>;
}

/** Gemini's response schema: uppercase types and `nullable` instead of type unions. */
function toGemini(s: Schema): Record<string, unknown> {
  switch (s.type) {
    case "object":
      return {
        type: "OBJECT",
        properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGemini(v)])),
        required: s.required,
        propertyOrdering: Object.keys(s.properties),
      };
    case "array":
      return { type: "ARRAY", items: toGemini(s.items), ...(s.minItems === undefined ? {} : { minItems: s.minItems }), ...(s.maxItems === undefined ? {} : { maxItems: s.maxItems }) };
    default:
      return {
        type: s.type.toUpperCase(),
        ...(s.enum ? { enum: s.enum, format: "enum" } : {}),
        ...(s.nullable ? { nullable: true } : {}),
        ...(s.description ? { description: s.description } : {}),
      };
  }
}

/** Strict JSON Schema for OpenAI structured outputs: nullable becomes a type union. */
function toOpenAi(s: Schema): Record<string, unknown> {
  switch (s.type) {
    case "object":
      return {
        type: "object",
        properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toOpenAi(v)])),
        required: Object.keys(s.properties),
        additionalProperties: false,
      };
    case "array":
      return { type: "array", items: toOpenAi(s.items) };
    default:
      return {
        type: s.nullable ? [s.type, "null"] : s.type,
        ...(s.enum ? { enum: s.nullable ? [...s.enum, null] : s.enum } : {}),
        ...(s.description ? { description: s.description } : {}),
      };
  }
}

function parseJsonText(provider: string, text: unknown): unknown {
  if (typeof text !== "string" || text.length === 0) throw new Error(`${provider}: empty response`);
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${provider}: response is not JSON`);
  }
}

export function gemini(apiKey: string, model: string, fetchImpl: Fetch = fetch): Provider {
  const name = `gemini:${model}`;
  return {
    name,
    async generate(system, user, schema) {
      const json = await fetchJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> }>(
        fetchImpl,
        name,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { responseMimeType: "application/json", responseSchema: toGemini(schema), temperature: 0.2 },
          }),
        },
        60_000,
      );
      const c = json.candidates?.[0];
      return parseJsonText(name, c?.content?.parts?.map((p) => p.text ?? "").join(""));
    },
  };
}

/** OpenAI, or any service with OpenAI's chat completions API (Kimi). */
export function openAiCompatible(label: string, baseUrl: string, apiKey: string, model: string, opts: { strictSchema: boolean }, fetchImpl: Fetch = fetch): Provider {
  const name = `${label}:${model}`;
  return {
    name,
    async generate(system, user, schema, schemaName) {
      const responseFormat = opts.strictSchema
        ? { type: "json_schema", json_schema: { name: schemaName, strict: true, schema: toOpenAi(schema) } }
        : { type: "json_object" };
      const prompt = opts.strictSchema ? user : `${user}\n\nAnswer with JSON matching this schema:\n${JSON.stringify(toOpenAi(schema))}`;
      const json = await fetchJson<{ choices?: Array<{ message?: { content?: string } }> }>(
        fetchImpl,
        name,
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            response_format: responseFormat,
          }),
        },
        60_000,
      );
      return parseJsonText(name, json.choices?.[0]?.message?.content);
    },
  };
}

export interface AiResult<T> {
  value: T;
  provider: string;
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
        const raw = await p.generate(system, user, schema, schemaName);
        const value = parse(raw);
        stats.ok++;
        stats.lastOkAt = this.now();
        return { value, provider: p.name };
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
