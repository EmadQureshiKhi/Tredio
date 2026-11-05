"use client";
import { X } from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * A modal on the native <dialog> element, which brings focus trapping, Escape and the top layer.
 * A bottom sheet on phones, a centered panel from `sm` up. `locked` keeps it open while a request
 * runs.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  locked = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  locked?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Closing before the element leaves the page hands focus back to where it was.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const requestClose = () => {
    if (!locked) onClose();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClose={() => {
        // The close event is queued, so it can arrive after the dialog was reopened (React's
        // development double mount does exactly that) or after it left the page. Only a dialog
        // that is still here and still closed is really closed.
        const dialog = ref.current;
        if (open && dialog && !dialog.open) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-2xl border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50 sm:m-auto sm:max-h-[calc(100dvh-4rem)] sm:w-[calc(100%-2rem)] sm:max-w-xl sm:rounded-2xl"
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          <header className="flex items-start gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-fg">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-0.5 truncate font-mono text-[13px] text-muted">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={requestClose}
              disabled={locked}
              aria-label="Close"
              className="-mr-2 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-subtle hover:bg-raised hover:text-fg disabled:opacity-50"
            >
              <X size={18} aria-hidden />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>
          {footer && <footer className="border-t border-line bg-surface px-5 py-3.5">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
