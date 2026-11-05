import { ASSET_CLASSES, type AssetClass, type Candidate, type DecisionRequest } from "@/src/types/admin";

/**
 * The review form's rules, the same ones the backend applies to a decision (decisionBody in
 * backend/src/api/app.ts and backend/src/identifiers.ts), so a form that passes here is accepted
 * there. Text is trimmed before it is checked and sent.
 */

export const LIMITS = { identifier: 64, displayName: 40, keyword: 60, keywords: 5, article: 200, summary: 140 } as const;

const IDENTIFIER_RE = /^[a-z0-9:._-]{1,64}$/;
/** A retired trend's return is listed as `<base>.<n>`; the backend assigns that suffix itself. */
const VERSION_RE = /\.([2-9])$/;

export interface Draft {
  identifier: string;
  displayName: string;
  keywords: string[];
  article: string;
  summary: string;
}

export interface DraftErrors {
  identifier?: string;
  displayName?: string;
  /** About the list as a whole. */
  keywords?: string;
  /** Per row, in order. */
  keyword?: Array<string | undefined>;
  article?: string;
  summary?: string;
}

export function draftFrom(c: Candidate): Draft {
  return { identifier: c.identifier, displayName: c.displayName, keywords: c.keywords.length > 0 ? [...c.keywords] : [""], article: c.article ?? "", summary: c.summary ?? "" };
}

/** A pasted Wikipedia URL becomes its article title; anything else is kept as typed. */
export function normalizeArticle(value: string): string {
  const v = value.trim();
  const match = v.match(/^https?:\/\/[a-z-]+\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if (!match) return v;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

export function identifierError(identifier: string): string | undefined {
  const id = identifier.trim();
  if (id.length === 0) return "Enter an identifier.";
  if (id.length > LIMITS.identifier) return `Use at most ${LIMITS.identifier} characters (now ${id.length}).`;
  if (!IDENTIFIER_RE.test(id)) return "Use lowercase a-z, 0-9 and : . _ - only.";
  if (VERSION_RE.test(id)) return "Drop the version suffix: versions such as .2 are assigned on listing.";
  return undefined;
}

/** The asset class an identifier stands for, as assetClassOf() in backend/src/identifiers.ts reads it. */
export function classOf(identifier: string): AssetClass {
  const prefix = identifier.split(":")[0] ?? "";
  return identifier.includes(":") && (ASSET_CLASSES as readonly string[]).includes(prefix) ? (prefix as AssetClass) : "topic";
}

/** Not enforced by the backend, but the asset class is read from the prefix. */
export function identifierWarning(identifier: string): string | undefined {
  const id = identifier.trim();
  const colon = id.indexOf(":");
  const cls = colon > 0 ? id.slice(0, colon) : "";
  if ((ASSET_CLASSES as readonly string[]).includes(cls) && id.length > colon + 1) return undefined;
  return `Write it as <class>:<slug>, with class one of ${ASSET_CLASSES.join(", ")}; without one it is read as a topic.`;
}

/**
 * `strict` also reports empty required fields. The form checks loosely while typing and strictly
 * on submit, so a row just added is not flagged before the reviewer has filled it in.
 */
export function validate(draft: Draft, strict: boolean): DraftErrors {
  const errors: DraftErrors = {};
  const id = identifierError(draft.identifier);
  if (id && (strict || draft.identifier.trim().length > 0)) errors.identifier = id;

  const name = draft.displayName.trim();
  if (name.length > LIMITS.displayName) errors.displayName = `Use at most ${LIMITS.displayName} characters (now ${name.length}).`;
  else if (strict && name.length === 0) errors.displayName = "Enter a display name.";

  const seen = new Set<string>();
  const perRow = draft.keywords.map((raw) => {
    const k = raw.trim();
    if (k.length === 0) return strict ? "Enter a keyword or remove this row." : undefined;
    if (k.length > LIMITS.keyword) return `Use at most ${LIMITS.keyword} characters (now ${k.length}).`;
    const key = k.toLowerCase();
    if (seen.has(key)) return "This keyword is already listed.";
    seen.add(key);
    return undefined;
  });
  if (perRow.some(Boolean)) errors.keyword = perRow;
  if (draft.keywords.length > LIMITS.keywords) errors.keywords = `Keep at most ${LIMITS.keywords} keywords.`;
  else if (strict && draft.keywords.every((k) => k.trim().length === 0)) errors.keywords = "Add at least one keyword.";

  const article = normalizeArticle(draft.article);
  if (article.length > LIMITS.article) errors.article = `Use at most ${LIMITS.article} characters (now ${article.length}).`;

  const summary = draft.summary.trim();
  if (summary.length > LIMITS.summary) errors.summary = `Use at most ${LIMITS.summary} characters (now ${summary.length}).`;

  return errors;
}

export const hasErrors = (errors: DraftErrors) => Object.keys(errors).length > 0;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The decision with only the fields the reviewer changed, so untouched values are never rewritten. */
export function decisionRequest(c: Candidate, draft: Draft, decision: DecisionRequest["decision"]): DecisionRequest {
  const body: DecisionRequest = { decision };
  const identifier = draft.identifier.trim();
  const displayName = draft.displayName.trim();
  const keywords = draft.keywords.map((k) => k.trim()).filter(Boolean);
  const article = normalizeArticle(draft.article) || null;
  const summary = draft.summary.trim();
  if (identifier !== c.identifier) body.identifier = identifier;
  if (displayName !== c.displayName) body.displayName = displayName;
  if (!sameList(keywords, c.keywords)) body.keywords = keywords;
  if (article !== c.article) body.article = article;
  if (summary !== (c.summary ?? "")) body.summary = summary;
  return body;
}
