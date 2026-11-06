"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/src/components/ui/Button";
import { Dialog } from "@/src/components/ui/Dialog";
import { describedBy, Field, inputClass } from "@/src/components/ui/Field";
import { Notice } from "@/src/components/ui/Notice";
import { useToast } from "@/src/components/ui/Toasts";
import { api, ApiError } from "@/src/lib/api";

const CLASSES = ["topic", "crypto", "equity", "commodity", "fx", "person", "politics"] as const;
const slugOf = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);

/**
 * Adds a topic by hand. It is approved at once and credited to the signed-in admin, with no AI
 * review, then waits in the queue like any approved candidate until the collector has measured it
 * and the oracle lists it.
 */
export function AddTopicDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ids = { cls: useId(), slug: useId(), name: useId(), keywords: useId(), article: useId(), summary: useId() };
  const [cls, setCls] = useState<(typeof CLASSES)[number]>("topic");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [keywords, setKeywords] = useState("");
  const [article, setArticle] = useState("");
  const [summary, setSummary] = useState("");
  const notify = useToast();
  const queryClient = useQueryClient();

  const effectiveSlug = slug || slugOf(name);
  const identifier = `${cls}:${effectiveSlug}`;
  const keywordList = keywords
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const problems = {
    name: name.trim().length === 0 ? "Name the topic." : name.trim().length > 40 ? "At most 40 characters." : undefined,
    slug: effectiveSlug.length === 0 ? "The identifier needs letters or digits." : undefined,
    keywords: keywordList.length === 0 ? "Give at least one keyword the sources search for." : keywordList.length > 5 ? "At most five keywords." : undefined,
    summary: summary.length > 140 ? "At most 140 characters." : undefined,
  };
  const valid = !Object.values(problems).some(Boolean);

  const add = useMutation({
    mutationFn: () =>
      api.addCandidate({ identifier, displayName: name.trim(), keywords: keywordList, article: article.trim() || null, summary: summary.trim() || null }),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "candidates"] });
      notify({ tone: "ok", title: `Added ${c.displayName}`, description: `${c.identifier} is approved and lists once the collector has measured it.` });
      setName("");
      setSlug("");
      setKeywords("");
      setArticle("");
      setSummary("");
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      locked={add.isPending}
      title="Add a topic"
      description={identifier}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} disabled={!valid} onClick={() => add.mutate()}>
            Add and approve
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted">
          A topic you add skips the AI review, so its listing carries no Verified chip. It is credited to your account and waits in the queue until the collector has measured it.
        </p>
        <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
          <Field id={ids.cls} label="Class">
            <select id={ids.cls} value={cls} onChange={(e) => setCls(e.target.value as (typeof CLASSES)[number])} className={inputClass(false, "h-9")}>
              {CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field id={ids.name} label="Name" counter={{ value: name.length, max: 40 }} error={name ? problems.name : undefined}>
            <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder="World Cup" className={inputClass(Boolean(name && problems.name), "h-9")} {...describedBy(ids.name, Boolean(name && problems.name), Boolean(name && problems.name))} />
          </Field>
        </div>
        <Field id={ids.slug} label="Identifier" hint={`Lowercase, from the name unless you set it: ${identifier}`} error={slug ? problems.slug : undefined}>
          <input id={ids.slug} value={slug} onChange={(e) => setSlug(slugOf(e.target.value))} placeholder={slugOf(name) || "world-cup"} className={inputClass(Boolean(slug && problems.slug), "h-9 font-mono")} {...describedBy(ids.slug, false, true)} />
        </Field>
        <Field id={ids.keywords} label="Keywords" hint="Comma-separated, up to five; cashtags like $NEAR for crypto." error={keywords ? problems.keywords : undefined}>
          <input id={ids.keywords} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="World Cup, FIFA" className={inputClass(Boolean(keywords && problems.keywords), "h-9")} {...describedBy(ids.keywords, false, true)} />
        </Field>
        <Field id={ids.article} label="Wikipedia article" hint="Optional: the exact title, for page views.">
          <input id={ids.article} value={article} onChange={(e) => setArticle(e.target.value)} placeholder="2026_FIFA_World_Cup" className={inputClass(false, "h-9")} {...describedBy(ids.article, false, true)} />
        </Field>
        <Field id={ids.summary} label="Summary" counter={{ value: summary.length, max: 140 }} error={problems.summary}>
          <textarea id={ids.summary} value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} className={inputClass(Boolean(problems.summary), "py-2")} />
        </Field>
        {add.error ? <Notice tone="bad">{add.error instanceof ApiError ? add.error.message : "The topic could not be added."}</Notice> : null}
      </div>
    </Dialog>
  );
}
