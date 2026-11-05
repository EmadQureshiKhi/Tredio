"use client";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ToastTone = "ok" | "bad" | "info";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

type Notify = (toast: Omit<Toast, "id">) => void;

const ToastContext = createContext<Notify | null>(null);

const ICONS = { ok: CircleCheck, bad: CircleAlert, info: Info } as const;
const ICON_COLOR = { ok: "text-ok", bad: "text-bad", info: "text-accent" } as const;
/** Errors stay longer: they usually need reading. */
const LIFETIME_MS = { ok: 5000, info: 5000, bad: 9000 } as const;

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const Icon = ICONS[toast.tone];
  useEffect(() => {
    const timer = setTimeout(() => onClose(toast.id), LIFETIME_MS[toast.tone]);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, onClose]);

  return (
    <li
      role={toast.tone === "bad" ? "alert" : "status"}
      className="pointer-events-auto flex w-full items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg shadow-black/10 animate-[toast-in_160ms_ease-out]"
    >
      <Icon size={18} className={`mt-px shrink-0 ${ICON_COLOR[toast.tone]}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{toast.title}</p>
        {toast.description && <p className="mt-0.5 break-words text-[13px] text-muted">{toast.description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onClose(toast.id)}
        aria-label="Dismiss"
        className="-mr-1.5 -mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-raised hover:text-fg"
      >
        <X size={15} aria-hidden />
      </button>
    </li>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const close = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const notify = useCallback<Notify>((toast) => {
    const id = nextId.current++;
    // Newest last, and at most four on screen.
    setToasts((all) => [...all.slice(-3), { ...toast, id }]);
  }, []);
  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ol
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={close} />
        ))}
      </ol>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast needs a ToastProvider");
  return notify;
}
