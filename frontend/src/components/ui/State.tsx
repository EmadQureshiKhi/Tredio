import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export function Empty({ title, body, action, icon, className }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      {icon ? <div className="mb-1 text-text-3">{icon}</div> : null}
      <p className="font-strong text-[15px] text-text">{title}</p>
      {body ? <p className="max-w-sm text-balance text-[13.5px] leading-5 text-text-2">{body}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start gap-3 rounded-xl border border-[color:var(--down-soft)] bg-down-soft px-4 py-3 text-[13px] text-text", className)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-down" aria-hidden />
      <p className="flex-1 leading-5">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="font-strong text-down underline-offset-2 hover:underline">
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * A whole-screen fallback (a page that does not exist, a screen that crashed): a small label, a
 * display headline, one line of what happened, and the way on.
 */
export function Fallback({ eyebrow, title, body, actions, footer, className }: { eyebrow: string; title: string; body: ReactNode; actions: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-[62vh] flex-col items-center justify-center px-2 py-16 text-center", className)}>
      <p className="font-strong text-[11.5px] uppercase tracking-[0.14em] text-primary">{eyebrow}</p>
      <h1 className="mt-3 max-w-xl text-balance font-display text-[34px] leading-[1.1] text-text sm:text-[44px]">{title}</h1>
      <p className="mt-3 max-w-md text-balance text-[14.5px] leading-6 text-text-2">{body}</p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      {footer ? <div className="mt-6 text-[12px] text-text-3">{footer}</div> : null}
    </div>
  );
}
