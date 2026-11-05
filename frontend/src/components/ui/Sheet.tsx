"use client";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Drawer } from "vaul";
import { cn } from "./cn";
import { useDesktop } from "./useMedia";

/**
 * A panel for focused tasks (tickets, deposits, the account): a bottom sheet on phones, a side
 * panel on desktop. Locked while `busy` so an in-flight action cannot be dismissed half done.
 */
export function Sheet({ open, onOpenChange, title, description, children, busy, testId, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; busy?: boolean; testId?: string; footer?: ReactNode }) {
  const desktop = useDesktop();
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)} direction={desktop ? "right" : "bottom"} shouldScaleBackground={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[80] bg-overlay backdrop-blur-[2px]" />
        <Drawer.Content
          data-testid={testId}
          className={cn(
            "fixed z-[90] flex flex-col border-line bg-surface outline-none",
            // Desktop: no vaul ::after, the panel-colored strip vaul extends past the edge to cover a
            // drag overshoot, which the inset would show as a sliver beside the rounded panel.
            desktop ? "inset-y-3 right-3 w-[420px] rounded-[22px] border after:hidden" : "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[22px] border-t",
          )}
        >
          {!desktop ? (
            <div className="flex justify-center pt-2.5">
              <div className="h-1 w-9 rounded-full bg-line-strong" />
            </div>
          ) : null}
          <div className="flex items-start justify-between gap-3 px-5 pt-4">
            <div className="min-w-0">
              <Drawer.Title className="font-strong text-[17px] text-text">{title}</Drawer.Title>
              {description ? <Drawer.Description className="mt-0.5 text-[13px] leading-5 text-text-2">{description}</Drawer.Description> : <Drawer.Description className="sr-only">{typeof title === "string" ? title : "Panel"}</Drawer.Description>}
            </div>
            <button type="button" onClick={() => !busy && onOpenChange(false)} disabled={busy} aria-label="Close" className="-mr-1 rounded-lg p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40">
              <X className="size-[18px]" />
            </button>
          </div>
          {/* Phones: the last control clears the home indicator. */}
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 pt-4", desktop || footer ? "pb-5" : "pb-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.75rem))]")}>{children}</div>
          {footer ? <div className="pb-safe border-t border-line px-5 py-4">{footer}</div> : null}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
