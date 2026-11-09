"use client";
import { Eye, EyeOff } from "lucide-react";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { formatAge, formatDate } from "@/src/lib/format";
import type { LastModeration, ModeratedCall, ModeratedPost, ModeratedSignal } from "@/src/types/admin";
import type { Moderating } from "./dialogs";
import { actionOf, CallerName, Direction, horizonLabel, OutcomeBadge, signalLine } from "./parts";

/** Who last hid or restored a row, and why. */
function LastAction({ last, now }: { last: LastModeration; now: number }) {
  const at = Date.parse(last.at);
  return (
    <p className="mt-2 break-words text-xs leading-5 text-subtle" data-testid="moderation-last">
      {actionOf(last.action).past}{" "}
      <span title={formatDate(at)}>{formatAge(at, now)}</span> by <span className="font-mono">{last.admin}</span>: {last.reason}
    </p>
  );
}

function Row({
  target,
  now,
  meta,
  children,
  onModerate,
}: {
  target: Moderating;
  now: number;
  meta: React.ReactNode;
  children: React.ReactNode;
  onModerate: (t: Moderating) => void;
}) {
  const { kind, item } = target;
  const hidden = item.hiddenAt !== null;
  return (
    <li
      data-testid="moderation-row"
      data-kind={kind}
      data-id={item.id}
      data-hidden={hidden ? "true" : "false"}
      className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4 sm:px-5 ${hidden ? "bg-raised/50" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <CallerName address={item.caller} handle={item.handle} />
          <span className="text-subtle">on</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-muted">{item.identifier}</span>
          {meta}
          {hidden && <Badge tone="warn">Hidden</Badge>}
        </div>
        {children}
        {item.lastAction && <LastAction last={item.lastAction} now={now} />}
      </div>
      {hidden ? (
        <Button size="sm" icon={<Eye size={14} aria-hidden />} onClick={() => onModerate(target)} className="self-start">
          Restore
        </Button>
      ) : (
        <Button size="sm" variant="danger" icon={<EyeOff size={14} aria-hidden />} onClick={() => onModerate(target)} className="self-start">
          Hide
        </Button>
      )}
    </li>
  );
}

const Id = ({ id }: { id: number }) => <span className="font-mono text-[12px] text-subtle">#{id}</span>;

export function PostRows({ rows, now, onModerate }: { rows: ModeratedPost[]; now: number; onModerate: (t: Moderating) => void }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="moderation-list">
      {rows.map((p) => {
        const created = Date.parse(p.createdAt);
        return (
          <Row
            key={p.id}
            target={{ kind: "posts", item: p }}
            now={now}
            onModerate={onModerate}
            meta={
              <span className="flex items-center gap-x-2 text-subtle">
                <span title={formatDate(created)}>{formatAge(created, now)}</span>
                <Id id={p.id} />
                {p.replyTo !== null && <span className="text-xs">reply to #{p.replyTo}</span>}
              </span>
            }
          >
            <p className={`mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 ${p.hiddenAt ? "text-muted" : "text-fg"}`}>{p.body}</p>
          </Row>
        );
      })}
    </ul>
  );
}

export function CallRows({ rows, now, onModerate }: { rows: ModeratedCall[]; now: number; onModerate: (t: Moderating) => void }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="moderation-list">
      {rows.map((c) => {
        const called = c.calledAt * 1000;
        return (
          <Row
            key={c.id}
            target={{ kind: "calls", item: c }}
            now={now}
            onModerate={onModerate}
            meta={
              <span className="flex items-center gap-x-2 text-subtle">
                <span title={formatDate(called)}>{formatAge(called, now)}</span>
                <Id id={c.id} />
              </span>
            }
          >
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <Direction direction={c.direction} />
              <span className="text-muted">
                from <span className="tabular-nums text-fg">{c.openingIndex.toFixed(2)}</span> over {horizonLabel(c.horizonSec)}
                {c.closingIndex !== null && (
                  <>
                    , closed at <span className="tabular-nums text-fg">{c.closingIndex.toFixed(2)}</span>
                  </>
                )}
                {c.outcome === "open" && (
                  <span title={formatDate(c.resolvesAt * 1000)}>{c.resolvesAt * 1000 > now ? `, resolves ${formatAge(c.resolvesAt * 1000, now)}` : ", waiting for its closing checkpoint"}</span>
                )}
              </span>
              <OutcomeBadge outcome={c.outcome} />
            </p>
            {c.note && <p className={`mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 ${c.hiddenAt ? "text-muted" : "text-fg"}`}>{c.note}</p>}
          </Row>
        );
      })}
    </ul>
  );
}

export function SignalRows({ rows, now, onModerate }: { rows: ModeratedSignal[]; now: number; onModerate: (t: Moderating) => void }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="moderation-list">
      {rows.map((g) => {
        const issued = g.issuedAt * 1000;
        const reveal = g.revealAt * 1000;
        return (
          <Row
            key={g.id}
            target={{ kind: "signals", item: g }}
            now={now}
            onModerate={onModerate}
            meta={
              <span className="flex items-center gap-x-2 text-subtle">
                <span title={formatDate(issued)}>{formatAge(issued, now)}</span>
                <Id id={g.id} />
                <span className="text-xs" title={formatDate(reveal)}>
                  {reveal > now ? `public ${formatAge(reveal, now)}` : "public"}
                </span>
              </span>
            }
          >
            {g.signal ? (
              <>
                <p className={`mt-1.5 text-sm ${g.hiddenAt ? "text-muted" : "text-fg"}`}>{signalLine(g.signal)}</p>
                {g.signal.note && <p className={`mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 ${g.hiddenAt ? "text-muted" : "text-fg"}`}>{g.signal.note}</p>}
              </>
            ) : (
              <p className="mt-1.5 text-sm text-muted">Sealed: this API does not hold the signals secret.</p>
            )}
          </Row>
        );
      })}
    </ul>
  );
}
