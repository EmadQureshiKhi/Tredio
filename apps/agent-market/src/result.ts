import { z } from "zod";

/**
 * The answer to one attention check: compact, and every number in it can be checked without
 * trusting this agent. The index and its checkpoint come from the registry contract (read over
 * NEAR RPC, with the oracle report that wrote it); the sources from Tredio's API, recomputed with
 * the oracle's published method; the review from NEAR AI Cloud's signed evidence, checked here.
 * The deliverable is Markdown: a short summary, then this object as a fenced `json` block.
 */

export const RESULT_SCHEMA_ID = "tredio.attention-check/v1";

const point = z.object({ t: z.number().int().describe("unix seconds"), v: z.number().describe("index points, 0 to 100") });

export const sourceSchema = z.object({
  source: z.enum(["elfa", "gdelt", "wikipedia", "bluesky", "nansen", "hn"]),
  label: z.string(),
  unit: z.string(),
  reading: z.number().nullable().describe("the raw measurement"),
  windowSec: z.number().nullable(),
  observedAt: z.number().nullable().describe("unix seconds"),
  counted: z.boolean().describe("whether it entered the index"),
  reason: z.string().nullable().describe("why it did not count"),
  component: z.number().nullable().describe("normalized value, 0 to 1"),
  weight: z.number(),
  points: z.number().describe("index points this source contributes"),
  share: z.number().describe("its share of the index, 0 to 1"),
});

export const resultSchema = z.object({
  schema: z.literal(RESULT_SCHEMA_ID),
  query: z.string().describe("the topic as the brief named it"),
  answeredAt: z.number().int().describe("unix seconds"),
  network: z.enum(["testnet", "mainnet"]).describe("the NEAR network Tredio's contracts are on"),
  match: z.object({
    status: z.enum(["listed", "candidate"]).describe("listed: a trend with an on-chain index; candidate: on the radar, waiting for a live slot"),
    how: z.enum(["identifier", "ticker", "name", "keyword", "slug", "words"]),
    alternatives: z.array(z.string()).describe("other identifiers that matched; ask again with one of them"),
    relistedFrom: z.string().nullable().describe("the retired listing the query named, when its topic listed again"),
  }),
  topic: z.object({
    identifier: z.string(),
    name: z.string().nullable(),
    summary: z.string().nullable(),
    assetClass: z.string(),
    status: z.string().describe("active, cooling, retired, or on_radar"),
    keywords: z.array(z.string()),
    wikipediaArticle: z.string().nullable(),
    ticker: z.string().nullable(),
    page: z.string().nullable().describe("the trend's page in the Tredio app"),
  }),
  index: z
    .object({
      now: z.number(),
      peak: z.number(),
      updatedAt: z.number().int(),
      change24h: z.object({ from: z.number(), to: z.number(), pct: z.number().nullable(), since: z.number().int().describe("time of the opening value: 24 hours ago, or the listing when it is younger") }).nullable(),
      min24h: z.number().nullable(),
      max24h: z.number().nullable(),
      checkpoints24h: z.number().int(),
      series24h: z.array(point).describe("one value an hour, the last checkpoint of each hour, oldest first"),
    })
    .nullable(),
  sources: z.array(sourceSchema),
  recomputed: z.object({ points: z.number().nullable(), note: z.string() }).nullable(),
  onChain: z
    .object({
      registry: z.string(),
      trend: z
        .object({ status: z.string(), index: z.number(), peak: z.number(), updatedAt: z.number().int(), fresh: z.boolean(), reviewHash: z.string().nullable() })
        .nullable(),
      checkpoint: z.object({ at: z.number().int(), index: z.number(), raw: z.number().int() }).nullable(),
      checkpoints: z.number().int().describe("checkpoints the registry keeps for the trend (the last 96)"),
      matchesApi: z.boolean().describe("the registry's index equals the API's"),
      oracleReport: z
        .object({
          verified: z.boolean(),
          reason: z.string().nullable(),
          transaction: z.string().nullable(),
          explorer: z.string().nullable(),
          runId: z.number().nullable(),
          oracleKey: z.string().nullable(),
          checks: z.record(z.string(), z.boolean()).nullable(),
        })
        .nullable()
        .describe("the signed oracle report that wrote the newest checkpoint, checked as the registry checks it"),
      verify: z.array(z.string()),
    })
    .nullable(),
  review: z
    .object({
      hash: z.string(),
      url: z.string(),
      onChainHashMatches: z.boolean().nullable().describe("the registry stores this review hash for the trend"),
      provider: z.string(),
      model: z.string(),
      signatureKind: z.string(),
      signingAlgo: z.string(),
      signingAddress: z.string(),
      verifyUrl: z.string(),
      createdAt: z.string(),
      checks: z.object({ hashMatches: z.boolean(), signatureMatchesSigner: z.boolean(), bodiesMatch: z.boolean().nullable() }),
      verified: z.boolean(),
      verify: z.array(z.string()),
    })
    .nullable(),
  radar: z
    .object({
      queue: z.number().int().nullable().describe("place in the listing queue"),
      slots: z.object({ live: z.number().int(), max: z.number().int() }).nullable(),
      signal: z.object({ label: z.string(), count: z.number().nullable(), unit: z.string().nullable() }).nullable(),
      readings: z.record(z.string(), z.number().nullable()),
      watchers: z.number().int(),
      source: z.string(),
      attribution: z.object({ text: z.string(), url: z.string() }).nullable(),
    })
    .nullable(),
  notes: z.array(z.string()),
});

export type AttentionResult = z.infer<typeof resultSchema>;
export type SourceRow = z.infer<typeof sourceSchema>;

/** The result's JSON Schema, for the listing's `output_schema`. */
export function outputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(resultSchema) as Record<string, unknown>;
}

/** The listing's `input_schema`: the topic, in words or as an identifier. */
export const INPUT_JSON_SCHEMA = {
  type: "object",
  properties: { topic: { type: "string", description: "Any topic in words (World Cup, $TSLA, Godzilla Minus Zero) or a Tredio identifier (topic:world-cup)" } },
  required: ["topic"],
} as const;

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "n/a" : v.toFixed(d).replace(/\.?0+$/, ""));
const signed = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

/** The deliverable: a short human summary, then the full result as JSON. */
export function renderMarkdown(r: AttentionResult): string {
  const lines: string[] = [];
  const name = r.topic.name ?? r.topic.identifier;
  lines.push(`# Attention check: ${name}`, "");
  if (r.index) {
    const c = r.index.change24h;
    const change = !c ? "no history yet" : c.since <= r.answeredAt - 86_400 ? `${signed(c.pct)} over 24 hours` : `${signed(c.pct)} since ${new Date(c.since * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    lines.push(`**${fmt(r.index.now)} / 100** on Tredio's attention index (\`${r.topic.identifier}\`, ${r.topic.status}), ${change}, peak ${fmt(r.index.peak)}.`);
  } else {
    lines.push(`\`${r.topic.identifier}\` is on Tredio's radar, waiting for a live slot${r.radar?.queue ? ` (queue #${r.radar.queue})` : ""}: it has no on-chain index yet.`);
  }
  if (r.topic.summary) lines.push("", r.topic.summary);
  const counted = r.sources.filter((s) => s.counted);
  if (counted.length > 0) {
    lines.push("", "| Source | Reading | Component | Points |", "| - | - | - | - |");
    for (const s of counted) lines.push(`| ${s.label} | ${s.reading === null ? "n/a" : s.reading.toLocaleString("en-US")} ${s.unit} | ${fmt(s.component, 3)} | ${fmt(s.points)} |`);
  }
  if (r.onChain?.checkpoint) {
    const report = r.onChain.oracleReport;
    lines.push("", `On chain: \`${r.onChain.registry}\` holds ${fmt(r.onChain.checkpoint.index)} at ${new Date(r.onChain.checkpoint.at * 1000).toISOString()}${report ? (report.verified ? `, written by an oracle report whose signature checks out (${report.transaction})` : ` (oracle report not verified: ${report.reason})`) : ""}.`);
  }
  if (r.review) lines.push("", `NEAR AI review \`${r.review.hash}\` (${r.review.model}, ${r.review.signatureKind}): ${r.review.verified ? "evidence, signature and bodies verified" : "not fully verified, see checks"}.`);
  for (const n of r.notes) lines.push("", `Note: ${n}`);
  lines.push("", "```json", JSON.stringify(r, null, 2), "```", "");
  return lines.join("\n");
}

/** The result inside a deliverable (its first `json` block), for callers and tests. */
export function parseDeliverable(markdown: string): AttentionResult {
  const m = /```json\n([\s\S]*?)\n```/.exec(markdown);
  if (!m) throw new Error("no json block in the deliverable");
  return resultSchema.parse(JSON.parse(m[1]!));
}
