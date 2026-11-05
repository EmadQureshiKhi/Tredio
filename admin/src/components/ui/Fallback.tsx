import type { ReactNode } from "react";

/** A whole-page fallback (a missing page, a crashed screen): icon, title, one line and the way on. */
export function Fallback({ icon, title, children, actions, footer }: { icon: ReactNode; title: string; children: ReactNode; actions: ReactNode; footer?: ReactNode }) {
  return (
    <section className="mx-auto mt-4 w-full max-w-md sm:mt-12">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-8">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">{icon}</div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-fg">{title}</h1>
        <div className="mt-2 text-sm leading-6 text-muted">{children}</div>
        <div className="mt-6 flex flex-wrap gap-2">{actions}</div>
      </div>
      {footer ? <p className="mt-4 text-center text-xs text-subtle">{footer}</p> : null}
    </section>
  );
}
