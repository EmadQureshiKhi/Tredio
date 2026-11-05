import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

type NoticeTone = "info" | "ok" | "warn" | "bad";

const STYLES: Record<NoticeTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: "border-line bg-raised", icon: "text-muted", Icon: Info },
  ok: { box: "border-ok/25 bg-ok-soft", icon: "text-ok", Icon: CircleCheck },
  warn: { box: "border-warn/30 bg-warn-soft", icon: "text-warn", Icon: TriangleAlert },
  bad: { box: "border-bad/25 bg-bad-soft", icon: "text-bad", Icon: CircleAlert },
};

/** An inline callout. Errors are announced to screen readers; the rest are read in place. */
export function Notice({ tone = "info", title, children, action }: { tone?: NoticeTone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const { box, icon, Icon } = STYLES[tone];
  return (
    <div role={tone === "bad" ? "alert" : undefined} className={`flex gap-3 rounded-lg border px-3.5 py-3 text-sm ${box}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${icon}`} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className="break-words text-muted">{children}</div>}
        {action && <div className="pt-1.5">{action}</div>}
      </div>
    </div>
  );
}
