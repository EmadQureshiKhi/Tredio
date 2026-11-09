/**
 * From a hire's brief to one Tredio topic: first the words that name it (a JSON `topic`, a trend
 * identifier, a `topic:` line, or the title stripped of the request around it), then the best
 * match among the listed trends (`GET /v1/trends?all=1`) and, failing those, the radar's
 * candidates waiting for a slot (`GET /v1/candidates`).
 */

/** A trend as `GET /v1/trends` lists it (backend/src/api/app.ts, trendJson). */
export interface ApiTrend {
  id: string;
  identifier: string;
  displayName: string | null;
  summary: string | null;
  assetClass: string;
  status: "active" | "cooling" | "retired" | string;
  index: number;
  peakIndex: number;
  createdAt: number;
  updatedAt: number;
  surfacer: string;
  reviewHash: string | null;
  asset: string | null;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  readings: Record<string, { value: number; windowSec: number; observedAt: number } | null>;
  change24h?: number | null;
  rotatingOut?: boolean;
}

/** A radar candidate as `GET /v1/candidates` lists it. */
export interface ApiCandidate {
  id: number;
  identifier: string;
  displayName: string | null;
  summary: string | null;
  assetClass: string;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  source: string;
  attribution: { text: string; url: string } | null;
  status: string;
  createdAt: string;
  queue: number | null;
  signal: { label: string; count: number | null; unit: string | null } | null;
  readings: Record<string, number | null>;
  spark?: number[];
  heating?: number | null;
  watchers: number;
  pick?: boolean;
}

export type MatchHow = "identifier" | "ticker" | "name" | "keyword" | "slug" | "words";

export interface Match<T> {
  item: T;
  how: MatchHow;
  score: number;
}

/** The largest topic text worth matching. */
const MAX_QUERY = 120;
const IDENTIFIER = /\b((?:crypto|equity|commodity|fx|person|politics|topic):[a-z0-9][a-z0-9._-]{0,62})\b/i;
const STOP = new Set(["the", "a", "an", "of", "for", "on", "in", "to", "and", "or", "is", "what", "whats", "how", "about", "please", "check", "attention", "index", "score", "tredio", "now", "today", "current", "me", "give", "get", "show", "tell"]);

/** Lowercase words joined by hyphens, as the backend slugs identifiers. */
export function slugify(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `topic:world-cup.2` to `topic:world-cup`: a topic that listed again keeps its base. */
export const baseOf = (identifier: string) => identifier.replace(/\.([2-9])$/, "");
const slugOf = (identifier: string) => baseOf(identifier).split(":").slice(1).join(":");
const words = (s: string) => slugify(s).split("-").filter((w) => w && !STOP.has(w));

/** The request around a topic in a title: "Attention check: World Cup?" is "World Cup". */
function strip(text: string): string {
  let s = text.trim().replace(/^[#>*\s-]+/, "");
  s = s.replace(/^(?:please\s+)?(?:(?:run|do|give me|get|show me|send)\s+)?(?:an?\s+|the\s+)?(?:tredio\s+)?attention(?:\s+(?:check|index|score|level|reading))?(?:\s*(?:for|of|on|about|:|-|–))?\s*/i, "");
  s = s.replace(/^(?:what(?:'s| is)|how (?:big|hot|loud) is)\s+(?:the\s+)?(?:attention(?:\s+(?:index|score))?\s+(?:for|of|on)\s+)?/i, "");
  s = s.replace(/^(?:topic|query|subject)\s*[:=]\s*/i, "");
  s = s.replace(/\s+(?:right now|now|today)\s*$/i, "");
  return s.replace(/^["'`“‘]+|["'`”’?!.\s]+$/g, "").trim();
}

/**
 * The topic texts a brief names, most explicit first: a JSON body's `topic` (this agent's input
 * schema), a trend identifier anywhere, a `topic:` line, then the title and the brief's first line
 * stripped of the request around them. Empty when nothing is left.
 */
export function topicQueries(title: string, description: string): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    const t = (s ?? "").trim().slice(0, MAX_QUERY);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const text of [description, title, `${title}\n${description}`]) {
    const json = text.trim();
    if (!json.startsWith("{")) continue;
    try {
      const v = JSON.parse(json) as { topic?: unknown; query?: unknown };
      if (typeof v.topic === "string") add(v.topic);
      else if (typeof v.query === "string") add(v.query);
    } catch {
      // Not JSON: read it as text below.
    }
  }
  const all = `${title}\n${description}`;
  add(IDENTIFIER.exec(all)?.[1]?.toLowerCase());
  for (const line of all.split("\n")) {
    const m = /^\s*(?:topic|query|subject)\s*[:=]\s*(.+)$/i.exec(line);
    if (m) add(strip(m[1]!));
  }
  add(strip(title));
  add(strip(description.split("\n").find((l) => l.trim()) ?? ""));
  return out.filter((q) => words(q).length > 0 || IDENTIFIER.test(q) || /^\$[a-z0-9]{1,15}$/i.test(q));
}

interface Named {
  identifier: string;
  displayName: string | null;
  keywords: string[];
  ticker: string | null;
}

/** How well `query` names `t`, 0 for not at all. */
export function score(query: string, t: Named): { score: number; how: MatchHow } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (q === t.identifier) return { score: 100, how: "identifier" };
  if (IDENTIFIER.test(q) && baseOf(q) === baseOf(t.identifier)) return { score: 95, how: "identifier" };
  const ticker = /^\$?([a-z0-9]{1,15})$/.exec(q)?.[1];
  if (ticker && t.ticker && ticker === t.ticker.toLowerCase()) return { score: q.startsWith("$") ? 90 : 75, how: "ticker" };
  const plain = q.replace(/^\$/, "");
  if (t.displayName && plain === t.displayName.toLowerCase()) return { score: 85, how: "name" };
  if (t.keywords.some((k) => plain === k.toLowerCase().replace(/^\$/, ""))) return { score: 80, how: "keyword" };
  const slug = slugify(q);
  if (slug && slug === slugOf(t.identifier)) return { score: 80, how: "slug" };
  // Words: the share of the query's words the topic carries, and of the topic name's words the query carries.
  const qw = new Set(words(q));
  if (qw.size === 0) return null;
  const names = [t.displayName ?? "", ...t.keywords, slugOf(t.identifier)].map((n) => new Set(words(n)));
  let best = 0;
  for (const n of names) {
    if (n.size === 0) continue;
    const shared = [...qw].filter((w) => n.has(w)).length;
    if (shared === 0) continue;
    best = Math.max(best, (shared / qw.size) * 0.6 + (shared / n.size) * 0.4);
  }
  return best >= 0.6 ? { score: Math.round(best * 60), how: "words" } : null;
}

const STATUS_RANK: Record<string, number> = { active: 3, cooling: 2, retired: 1 };

/** The trends `query` names, best first: score, then live before retired, then the newest listing. */
export function matchTrends(query: string, trends: readonly ApiTrend[]): Match<ApiTrend>[] {
  return trends
    .flatMap((t) => {
      const s = score(query, t);
      return s ? [{ item: t, ...s }] : [];
    })
    .sort((a, b) => b.score - a.score || (STATUS_RANK[b.item.status] ?? 0) - (STATUS_RANK[a.item.status] ?? 0) || b.item.createdAt - a.item.createdAt);
}

export function matchCandidates(query: string, candidates: readonly ApiCandidate[]): Match<ApiCandidate>[] {
  return candidates
    .flatMap((c) => {
      const s = score(query, c);
      return s ? [{ item: c, ...s }] : [];
    })
    .sort((a, b) => b.score - a.score || (a.item.queue ?? Number.MAX_SAFE_INTEGER) - (b.item.queue ?? Number.MAX_SAFE_INTEGER));
}

export type Resolution =
  | { kind: "trend"; query: string; how: MatchHow; trend: ApiTrend; alternatives: string[] }
  | { kind: "candidate"; query: string; how: MatchHow; candidate: ApiCandidate; slots: { live: number; max: number } | null; alternatives: string[] };

/**
 * The topic the queries name: the first query that matches a trend (live or retired) wins, then
 * the first that matches a radar candidate. `alternatives` lists other close matches, so a caller
 * who meant another topic can ask again by identifier. Null when nothing matches.
 */
export function resolve(queries: readonly string[], trends: readonly ApiTrend[], radar: { candidates: readonly ApiCandidate[]; slots: { live: number; max: number } | null }): Resolution | null {
  const others = <T extends { identifier: string }>(ms: Match<T>[], chosen: string) => [...new Set(ms.map((m) => m.item.identifier).filter((id) => id !== chosen && baseOf(id) !== baseOf(chosen)))].slice(0, 5);
  for (const query of queries) {
    const ms = matchTrends(query, trends);
    const best = ms[0];
    if (best) return { kind: "trend", query, how: best.how, trend: best.item, alternatives: others(ms, best.item.identifier) };
  }
  for (const query of queries) {
    const ms = matchCandidates(query, radar.candidates);
    const best = ms[0];
    if (best) return { kind: "candidate", query, how: best.how, candidate: best.item, slots: radar.slots, alternatives: others(ms, best.item.identifier) };
  }
  return null;
}
