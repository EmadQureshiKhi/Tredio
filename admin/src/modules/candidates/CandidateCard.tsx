"use client";
import { CircleCheck, PenLine, X } from "lucide-react";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { formatAge, formatDate } from "@/src/lib/format";
import type { Candidate } from "@/src/types/admin";
import { actorLabel, AiVerdict, Confidence, narrativeText, SourceDetail, StatusBadge } from "./parts";

function Meta({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5" title={title}>
      <dt className="shrink-0 text-subtle">{label}</dt>
      <dd className="flex min-w-0 items-center text-fg">{children}</dd>
    </div>
  );
}

export function CandidateCard({
  candidate: c,
  now,
  rejecting,
  onReview,
  onReject,
}: {
  candidate: Candidate;
  now: number;
  /** A quick reject from this card is in flight. */
  rejecting: boolean;
  onReview: () => void;
  onReject: () => void;
}) {
  const nameId = `candidate-${c.id}-name`;
  const created = Date.parse(c.createdAt);
  const narrative = narrativeText(c);
  const surfacer = actorLabel(c.surfacer);
  const decidedBy = actorLabel(c.decidedBy);

  return (
    <article aria-labelledby={nameId} data-candidate-id={c.id} className="rounded-xl border border-line bg-surface shadow-card">
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 id={nameId} className="min-w-0 break-words text-[15px] font-semibold leading-6 text-fg">
                {c.displayName}
              </h3>
              <StatusBadge status={c.status} />
              <Badge testId="candidate-class">{c.assetClass}</Badge>
              {c.ticker && <Badge>${c.ticker}</Badge>}
            </div>
            <p className="mt-0.5 break-words font-mono text-[13px] text-muted" data-testid="candidate-identifier">
              {c.identifier}
            </p>
          </div>
          <div className="pt-1">
            <Confidence value={c.confidence} />
          </div>
        </div>

        {c.summary && <p className="text-sm leading-6 text-muted">{c.summary}</p>}
        {narrative && narrative !== c.summary && (
          <blockquote className="border-l-2 border-line-strong pl-3 text-[13px] leading-5 text-muted">{narrative}</blockquote>
        )}

        {c.keywords.length > 0 && (
          <ul aria-label="Keywords" className="flex flex-wrap gap-1.5">
            {c.keywords.map((k) => (
              <li key={k} className="rounded-md border border-line bg-raised px-2 py-0.5 text-xs leading-5 text-fg">
                {k}
              </li>
            ))}
          </ul>
        )}

        <AiVerdict ai={c.ai ?? {}} />
      </div>

      <div className="flex flex-col gap-3 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px]">
          <Meta label="Source">
            <SourceDetail candidate={c} />
          </Meta>
          {surfacer && (
            <Meta label="Surfacer" title={c.surfacer}>
              {surfacer === "Radar" ? <span>{surfacer}</span> : <span className="font-mono">{surfacer}</span>}
            </Meta>
          )}
          <Meta label="Created" title={Number.isFinite(created) ? formatDate(created) : undefined}>
            <time dateTime={c.createdAt}>{Number.isFinite(created) ? formatAge(created, now) : "unknown"}</time>
          </Meta>
          {decidedBy && (
            <Meta label="Decided by" title={c.decidedBy ?? undefined}>
              <span className={decidedBy === "Radar" ? "" : "font-mono"}>{decidedBy}</span>
            </Meta>
          )}
        </dl>

        {c.status === "live" ? (
          <p className="flex items-center gap-1.5 text-[13px] text-muted">
            <CircleCheck size={15} className="text-accent" aria-hidden />
            Listed
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
            {c.status !== "rejected" && (
              <Button variant="danger" size="sm" icon={<X size={14} aria-hidden />} loading={rejecting} onClick={onReject}>
                Reject
              </Button>
            )}
            <Button
              variant={c.status === "approved" ? "secondary" : "primary"}
              size="sm"
              icon={<PenLine size={14} aria-hidden />}
              disabled={rejecting}
              onClick={onReview}
              className={c.status === "rejected" ? "col-span-2" : ""}
            >
              {c.status === "approved" ? "Edit" : "Review"}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
