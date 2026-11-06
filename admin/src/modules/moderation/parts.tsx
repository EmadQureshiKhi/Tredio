import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type Tone } from "@/src/components/ui/Badge";
import { shortAddress } from "@/src/lib/format";
import type { ContentKind, ModeratedCall, ModerationAction } from "@/src/types/admin";

/** Every moderation query sits under ["admin", "moderation"], dropped on sign-out and refetched after each change. */
export const moderationKey = ["admin", "moderation"] as const;

/** A caller identity as the backend stores one, or a handle (the content filter takes either). */
export const CALLER = /^[a-z0-9._:-]{2,128}$/;
export const HANDLE = /^[a-z0-9_]{3,20}$/;
export const REASON_MAX = 200;
export const BIO_MAX = 160;

export const noun = (kind: ContentKind) => (kind === "calls" ? "call" : "post");

/** A caller by handle, or by a shortened identity in mono. */
export function CallerName({ address, handle }: { address: string; handle: string | null }) {
  return handle ? (
    <span className="truncate font-medium text-fg" title={address}>
      @{handle}
    </span>
  ) : (
    <span className="truncate font-mono text-[13px] text-fg" title={address}>
      {shortAddress(address)}
    </span>
  );
}

const ACTIONS: Record<ModerationAction, { label: string; past: string; tone: Tone }> = {
  hide_post: { label: "Hid post", past: "Hidden", tone: "warn" },
  hide_call: { label: "Hid call", past: "Hidden", tone: "warn" },
  restore_post: { label: "Restored post", past: "Restored", tone: "ok" },
  restore_call: { label: "Restored call", past: "Restored", tone: "ok" },
  rename_caller: { label: "Edited profile", past: "Edited", tone: "accent" },
  remove_post: { label: "Deleted post", past: "Deleted", tone: "bad" },
  remove_call: { label: "Deleted call", past: "Deleted", tone: "bad" },
};

export const actionOf = (action: ModerationAction) => ACTIONS[action] ?? { label: action, past: action, tone: "neutral" as const };

/** "24 hours" or "7 days": a call's horizon. */
export const horizonLabel = (sec: number) => (sec >= 2 * 86_400 ? `${Math.round(sec / 86_400)} days` : `${Math.round(sec / 3600)} hours`);

/** Up or down, with its arrow (never color alone). */
export function Direction({ direction }: { direction: ModeratedCall["direction"] }) {
  const up = direction === "up";
  return (
    <span className={`inline-flex items-center gap-0.5 font-medium ${up ? "text-ok" : "text-bad"}`}>
      {up ? <ArrowUpRight size={14} aria-hidden /> : <ArrowDownRight size={14} aria-hidden />}
      {up ? "Up" : "Down"}
    </span>
  );
}

const OUTCOMES: Record<ModeratedCall["outcome"], { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "neutral" },
  hit: { label: "Hit", tone: "ok" },
  miss: { label: "Miss", tone: "bad" },
  void: { label: "Void", tone: "neutral" },
};

export function OutcomeBadge({ outcome }: { outcome: ModeratedCall["outcome"] }) {
  const o = OUTCOMES[outcome] ?? { label: outcome, tone: "neutral" as const };
  return <Badge tone={o.tone}>{o.label}</Badge>;
}

/** The dashed empty state the other lists use. */
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl bg-raised text-subtle">{icon}</div>
      <h2 className="mt-4 text-sm font-semibold text-fg">{title}</h2>
      <p className="mt-1 max-w-sm text-sm leading-6 text-muted">{children}</p>
    </div>
  );
}

/** Rows loading, shaped like a list of content. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2.5 border-b border-line px-4 py-4 last:border-b-0 sm:px-5">
          <div className="flex items-center gap-3">
            <div className="h-4 w-28 animate-pulse rounded bg-raised" />
            <div className="h-4 w-24 animate-pulse rounded bg-raised" />
            <div className="ml-auto h-8 w-20 animate-pulse rounded-lg bg-raised" />
          </div>
          <div className="h-4 w-full max-w-xl animate-pulse rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}
