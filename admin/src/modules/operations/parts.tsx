import type { HTMLAttributes, ReactNode } from "react";
import { formatAge, formatDate } from "@/src/lib/format";

/** Building blocks of the operations page. */

const time = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

export function Card({ icon, title, status, children, ...rest }: { icon: ReactNode; title: string; status?: ReactNode; children: ReactNode } & Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5" {...rest}>
      <div className="flex min-h-6 items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span className="text-subtle">{icon}</span>
          {title}
        </h3>
        {status}
      </div>
      <div className="mt-3 flex-1 text-[13px]">{children}</div>
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-line">{children}</dl>;
}

export function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-subtle">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere] text-right text-fg tabular-nums" title={title}>
        {children}
      </dd>
    </div>
  );
}

export function Ago({ iso, now }: { iso: string | null; now: number }) {
  const t = time(iso);
  if (!Number.isFinite(t)) return <span className="text-subtle">never</span>;
  return (
    <time dateTime={iso!} title={formatDate(t)}>
      {formatAge(t, now)}
    </time>
  );
}

