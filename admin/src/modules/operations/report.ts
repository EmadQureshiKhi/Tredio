import { formatDuration, formatNumber } from "@/src/lib/format";

/**
 * Job reports are free-form JSON (RadarReport and CollectorReport in the backend). Known keys get
 * readable labels; anything new still shows, labelled from its name.
 */

const LABELS: Record<string, string> = {
  run: "Run number",
  signals: "Signals",
  assessed: "Assessed by AI",
  approved: "Auto-approved",
  pending: "Sent to review",
  rejected: "Rejected",
  provider: "AI provider",
  skipped: "Skipped",
  tracked: "Tracked trends",
  measured: "Measured",
  failed: "Failed",
  listed: "Newly listed",
  notes: "Notes",
  elfaIntervalSec: "Elfa refresh",
  trends: "Trends read",
  added: "Checkpoints added",
  ms: "Duration",
};

/** Display order for known keys; the database does not keep the order a report was written in. */
const ORDER = ["signals", "assessed", "approved", "pending", "rejected", "provider", "skipped", "run", "tracked", "measured", "failed", "listed", "elfaIntervalSec", "notes", "trends", "added", "ms"];
const rank = (key: string) => {
  const i = ORDER.indexOf(key);
  return i >= 0 ? i : ORDER.length - 1.5;
};

/** Keys whose values are sentences, shown one per line. */
const SENTENCE_LISTS = new Set(["skipped", "notes"]);

export interface ReportRow {
  key: string;
  label: string;
  value: string;
  /** One entry per line instead of a single value. */
  lines?: string[];
}

function humanize(key: string): string {
  const words = key
    .replace(/Sec$/, "")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "number") {
    if (key === "ms") return formatDuration(value);
    if (key.endsWith("Sec")) return formatDuration(value * 1000);
    return formatNumber(value);
  }
  if (typeof value === "string") return value || "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length === 0 ? "none" : entries.map(([k, v]) => `${k} ${typeof v === "number" ? formatNumber(v) : String(v)}`).join(", ");
  }
  return String(value);
}

export function reportRows(report: Record<string, unknown> | null | undefined): ReportRow[] {
  if (!report) return [];
  // Unknown keys go just before the duration, alphabetically.
  const keys = Object.keys(report).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return keys.map((key) => {
    const value = report[key];
    const label = LABELS[key] ?? humanize(key);
    if (SENTENCE_LISTS.has(key) && Array.isArray(value) && value.length > 0) {
      return { key, label, value: `${value.length}`, lines: value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))) };
    }
    return { key, label, value: formatValue(key, value) };
  });
}
