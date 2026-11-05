"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Plus, Trash2, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { Dialog } from "@/src/components/ui/Dialog";
import { describedBy, Field, inputClass } from "@/src/components/ui/Field";
import { Notice } from "@/src/components/ui/Notice";
import { useToast } from "@/src/components/ui/Toasts";
import { ApiError } from "@/src/lib/api";
import { wikipediaUrl } from "@/src/lib/format";
import type { Candidate } from "@/src/types/admin";
import { AiVerdict, Confidence, SourceDetail, StatusBadge } from "./parts";
import { useDecision } from "./queries";
import { classOf, decisionRequest, draftFrom, hasErrors, identifierWarning, LIMITS, normalizeArticle, validate, type Draft } from "./validation";

type Decision = "approve" | "reject";

/** Review form: edit what the AI proposed, then approve or reject. Only changed fields are sent. */
export function ReviewDialog({ candidate: c, onClose }: { candidate: Candidate; onClose: () => void }) {
  const ids = useId();
  const notify = useToast();
  const queryClient = useQueryClient();
  const decision = useDecision();
  const formRef = useRef<HTMLFormElement>(null);
  const keywordRefs = useRef<Array<HTMLInputElement | null>>([]);

  const [draft, setDraft] = useState<Draft>(() => draftFrom(c));
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** A 409 is about one identifier; it clears once the reviewer edits it. */
  const [conflict, setConflict] = useState<string | null>(null);

  const errors = validate(draft, attempted);
  const identifierError = errors.identifier ?? (conflict !== null && draft.identifier.trim() === conflict ? "Another candidate already uses this identifier." : undefined);
  // The backend moves the asset class to an edited identifier's prefix.
  const nextClass = classOf(draft.identifier.trim());
  const classChange = draft.identifier.trim() !== c.identifier && nextClass !== c.assetClass ? `Saving moves the class from ${c.assetClass} to ${nextClass}.` : undefined;
  const identifierHint = identifierError ? undefined : (identifierWarning(draft.identifier) ?? classChange);
  const article = normalizeArticle(draft.article);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setKeyword = (i: number, value: string) => setDraft((d) => ({ ...d, keywords: d.keywords.map((k, j) => (j === i ? value : k)) }));
  const addKeyword = () => {
    if (draft.keywords.length >= LIMITS.keywords) return;
    setDraft((d) => ({ ...d, keywords: [...d.keywords, ""] }));
    requestAnimationFrame(() => keywordRefs.current[draft.keywords.length]?.focus());
  };
  const removeKeyword = (i: number) => setDraft((d) => ({ ...d, keywords: d.keywords.filter((_, j) => j !== i) }));

  const focusFirstInvalid = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());

  const submit = (kind: Decision) => {
    if (submitting) return;
    setFormError(null);
    if (hasErrors(validate(draft, true))) {
      setAttempted(true);
      focusFirstInvalid();
      return;
    }
    const body = decisionRequest(c, draft, kind);
    setSubmitting(kind);
    decision.mutate(
      { id: c.id, body },
      {
        onSuccess: (updated) => {
          notify(
            kind === "approve"
              ? { tone: "ok", title: `Approved ${updated.displayName}`, description: `${updated.identifier} is listed once the collector has measured it.` }
              : { tone: "ok", title: `Rejected ${updated.displayName}`, description: `${updated.identifier} will not be listed.` },
          );
          onClose();
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) return setFormError(err.message || "The decision failed.");
          if (err.status === 401) return; // The session ended; the sign-in screen takes over.
          if (err.status === 409) {
            setConflict(body.identifier ?? draft.identifier.trim());
            focusFirstInvalid();
          } else if (err.status === 400) {
            setFormError(`The backend rejected the form: ${err.message}.`);
          } else if (err.status === 404) {
            setFormError("This candidate no longer exists or is already live. Close this form to see the current list.");
            void queryClient.invalidateQueries({ queryKey: ["admin", "candidates"] });
          } else {
            setFormError(err.status === 0 ? err.message : `The decision failed: ${err.message}.`);
          }
        },
        onSettled: () => setSubmitting(null),
      },
    );
  };

  const footer = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs leading-5 text-subtle">Approved candidates are listed once the collector has measured them.</p>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
        <Button variant="danger" icon={<X size={16} aria-hidden />} loading={submitting === "reject"} disabled={submitting !== null} onClick={() => submit("reject")}>
          Reject
        </Button>
        <Button variant="primary" icon={<Check size={16} aria-hidden />} loading={submitting === "approve"} disabled={submitting !== null} onClick={() => submit("approve")}>
          Approve
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open onClose={onClose} locked={submitting !== null} title={`Review ${c.displayName}`} description={c.identifier} footer={footer}>
      <form ref={formRef} noValidate onSubmit={(e) => e.preventDefault()} className="space-y-5" aria-label="Review candidate">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
            <div className="flex items-center gap-1.5">
              <StatusBadge status={c.status} />
              <Badge>{c.assetClass}</Badge>
            </div>
            <Confidence value={c.confidence} />
            <div className="flex min-w-0 max-w-full items-center gap-1.5">
              <span className="shrink-0 text-subtle">Source</span>
              <SourceDetail candidate={c} />
            </div>
          </div>
          <AiVerdict ai={c.ai ?? {}} />
        </div>

        {formError && <Notice tone="bad">{formError}</Notice>}

        <Field
          id={`${ids}-identifier`}
          label="Identifier"
          counter={{ value: draft.identifier.trim().length, max: LIMITS.identifier }}
          error={identifierError}
          warning={identifierHint}
          hint="Lowercase <class>:<slug>. It becomes the trend's permanent key."
        >
          <input
            id={`${ids}-identifier`}
            value={draft.identifier}
            onChange={(e) => set("identifier", e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className={inputClass(Boolean(identifierError), "h-9 font-mono")}
            {...describedBy(`${ids}-identifier`, Boolean(identifierError), true)}
          />
        </Field>

        <Field id={`${ids}-name`} label="Display name" counter={{ value: draft.displayName.trim().length, max: LIMITS.displayName }} error={errors.displayName}>
          <input
            id={`${ids}-name`}
            value={draft.displayName}
            onChange={(e) => set("displayName", e.target.value)}
            autoComplete="off"
            className={inputClass(Boolean(errors.displayName), "h-9")}
            {...describedBy(`${ids}-name`, Boolean(errors.displayName), Boolean(errors.displayName))}
          />
        </Field>

        <fieldset>
          <div className="mb-1.5 flex min-h-5 items-center justify-between gap-3">
            <legend className="text-[13px] font-medium text-fg">Keywords</legend>
            <span className={`text-xs tabular-nums ${draft.keywords.length > LIMITS.keywords ? "font-medium text-bad" : "text-subtle"}`} aria-hidden>
              {draft.keywords.length}/{LIMITS.keywords}
            </span>
          </div>
          <div className="space-y-2">
            {draft.keywords.map((keyword, i) => {
              const error = errors.keyword?.[i];
              const id = `${ids}-keyword-${i}`;
              return (
                <div key={i}>
                  <div className="flex gap-2">
                    <input
                      id={id}
                      ref={(el) => {
                        keywordRefs.current[i] = el;
                      }}
                      value={keyword}
                      onChange={(e) => setKeyword(i, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addKeyword();
                        }
                      }}
                      aria-label={`Keyword ${i + 1}`}
                      autoComplete="off"
                      className={inputClass(Boolean(error), "h-9")}
                      {...describedBy(id, Boolean(error), Boolean(error))}
                    />
                    <button
                      type="button"
                      onClick={() => removeKeyword(i)}
                      disabled={draft.keywords.length <= 1}
                      aria-label={`Remove keyword ${i + 1}`}
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-strong text-subtle transition-colors hover:bg-raised hover:text-bad disabled:pointer-events-none disabled:opacity-40"
                    >
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </div>
                  {error && (
                    <p id={`${id}-message`} className="mt-1.5 text-xs leading-5 text-bad">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <Button variant="ghost" size="sm" icon={<Plus size={14} aria-hidden />} onClick={addKeyword} disabled={draft.keywords.length >= LIMITS.keywords} className="-ml-2 mt-1.5">
            Add keyword
          </Button>
          <p className={`mt-1 text-xs leading-5 ${errors.keywords ? "text-bad" : "text-subtle"}`} role={errors.keywords ? "alert" : undefined}>
            {errors.keywords ?? "Terms the collector searches for, such as $TICKER or a name. Enter adds a row."}
          </p>
        </fieldset>

        <Field
          id={`${ids}-article`}
          label="Wikipedia article"
          error={errors.article}
          hint="The title as it appears in the article URL. Leave empty for none."
          aside={
            article && !errors.article ? (
              <a
                href={wikipediaUrl(article)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent underline-offset-2 hover:underline"
              >
                Open
                <ExternalLink size={12} aria-hidden />
              </a>
            ) : null
          }
        >
          <input
            id={`${ids}-article`}
            value={draft.article}
            onChange={(e) => set("article", e.target.value)}
            onBlur={() => set("article", normalizeArticle(draft.article))}
            placeholder="Bella_Ramsey"
            autoComplete="off"
            spellCheck={false}
            className={inputClass(Boolean(errors.article), "h-9")}
            {...describedBy(`${ids}-article`, Boolean(errors.article), true)}
          />
        </Field>

        <Field id={`${ids}-summary`} label="Summary" counter={{ value: draft.summary.trim().length, max: LIMITS.summary }} error={errors.summary}>
          <textarea
            id={`${ids}-summary`}
            value={draft.summary}
            onChange={(e) => set("summary", e.target.value)}
            rows={3}
            className={inputClass(Boolean(errors.summary), "block resize-none py-2 leading-6")}
            {...describedBy(`${ids}-summary`, Boolean(errors.summary), Boolean(errors.summary))}
          />
        </Field>
      </form>
    </Dialog>
  );
}
