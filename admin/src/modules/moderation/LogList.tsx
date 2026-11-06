"use client";
import { Badge } from "@/src/components/ui/Badge";
import { formatAge, formatDate, shortAddress } from "@/src/lib/format";
import type { ModerationLogEntry } from "@/src/types/admin";
import { actionOf } from "./parts";

const text = (v: unknown) => (typeof v === "string" ? v : null);

/** What the entry acted on: "post #12", "call #7", or a caller's identity (the handle may since have changed). */
function Target({ e }: { e: ModerationLogEntry }) {
  const [kind, id] = e.target.split(":");
  if ((kind === "posts" || kind === "calls") && id) return <span className="font-medium text-fg">{`${kind === "posts" ? "post" : "call"} #${id}`}</span>;
  return (
    <span className="font-mono text-[12px] text-fg" title={e.target}>
      {shortAddress(e.target)}
    </span>
  );
}

/** The content as it stood before the action: a post's body, a call's direction and trend, or the old profile. */
function beforeOf(e: ModerationLogEntry): string | null {
  const b = e.before;
  if (e.action === "rename_caller") return `Was ${text(b.handle) ? `@${text(b.handle)}` : "without a handle"}${text(b.bio) ? `: ${text(b.bio)}` : ""}`;
  if (e.target.startsWith("posts:")) return text(b.body);
  if (e.target.startsWith("calls:")) {
    const direction = text(b.direction);
    const note = text(b.note);
    return direction ? `${direction === "up" ? "Up" : "Down"} on ${text(b.identifier) ?? "a trend"}${note ? `: ${note}` : ""}` : null;
  }
  return null;
}

/** The newest moderation actions: who did what to which row, why, and what it said then. */
export function LogList({ rows, now }: { rows: ModerationLogEntry[]; now: number }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="moderation-log">
      {rows.map((e) => {
        const at = Date.parse(e.createdAt);
        const a = actionOf(e.action);
        const before = beforeOf(e);
        return (
          <li key={e.id} className="px-4 py-3.5 sm:px-5" data-testid="log-row" data-action={e.action} data-target={e.target}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              <Badge tone={a.tone}>{a.label}</Badge>
              <Target e={e} />
              <span className="text-subtle">
                by <span className="font-mono">{e.admin}</span>
              </span>
              <span className="ml-auto text-xs text-subtle" title={formatDate(at)}>
                {formatAge(at, now)}
              </span>
            </div>
            <p className="mt-1.5 break-words text-sm leading-6 text-fg">{e.reason}</p>
            {before && <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted">{before}</p>}
          </li>
        );
      })}
    </ul>
  );
}
