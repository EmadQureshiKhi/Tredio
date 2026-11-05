import type { ReactNode } from "react";
import { cn } from "@/components/ui";

/** One settings group: a titled card that the side navigation links to. */
export function Section({ id, title, description, action, children, className }: { id: string; title: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-24 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card sm:p-6", className)} data-testid={`settings-${id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="font-strong text-[16px] leading-6 text-text">
            {title}
          </h2>
          {description ? <p className="mt-1 max-w-2xl text-[13.5px] leading-5 text-text-2">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A label and its content in a settings row, stacked on phones. */
export function SettingRow({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6", className)}>
      <div className="min-w-0">
        <p className="font-strong text-[13.5px] text-text">{label}</p>
        {hint ? <p className="mt-0.5 text-[12.5px] leading-[18px] text-text-3">{hint}</p> : null}
      </div>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
