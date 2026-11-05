"use client";
import { Check, Link2, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, cn } from "@/components/ui";
import { useCopy } from "@/lib/hooks/useCopy";
import { appOrigin, shareToX } from "./share";

/** The X logo, drawn here because the icon set carries no brand marks. */
export function XLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.17h1.7L7.4 4.74H5.58l11.09 14.43Z" />
    </svg>
  );
}

/** "Share to X" and "Copy link" for a page of this app (`path` is relative to the app's origin). */
export function ShareActions({ text, path, className, size = "md" }: { text: string; path: string; className?: string; size?: "sm" | "md" | "lg" }) {
  const { copied, copy } = useCopy();
  const url = () => `${appOrigin()}${path}`;
  return (
    <div className={cn("flex flex-wrap gap-2", className)} data-share-path={path}>
      <Button size={size} icon={<XLogo className="size-4" />} onClick={() => shareToX({ text, url: url() })}>
        Share to X
      </Button>
      <Button
        size={size}
        tone="secondary"
        icon={copied ? <Check className="size-4 text-up" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
        onClick={() => void copy(url(), "Link copied")}
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

const ITEM = "flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left font-strong text-[13px] text-text transition-colors hover:bg-surface-2 focus-visible:bg-surface-2";

/**
 * A Share button with a small menu: "Share to X" and "Copy link". Closes on a choice, a click
 * outside or Escape; a copied link shows its check for a moment before the menu goes.
 */
export function ShareMenu({ text, path, className }: { text: string; path: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const { copied, copy } = useCopy();
  const root = useRef<HTMLDivElement>(null);
  const url = () => `${appOrigin()}${path}`;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={root} className={cn("relative", className)} data-share-path={path}>
      <Button tone="secondary" size="sm" icon={<Share2 className="size-3.5" aria-hidden />} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} data-testid="share-menu">
        Share
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Share"
          className="absolute right-0 top-10 z-40 w-[184px] origin-top-right rounded-[14px] border border-line bg-surface p-1 shadow-pop transition-[opacity,scale] duration-150 ease-out starting:scale-[0.96] starting:opacity-0"
        >
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              shareToX({ text, url: url() });
              setOpen(false);
            }}
          >
            <XLogo className="size-4 text-text-2" />
            Share to X
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              void copy(url(), "Link copied").then(() => setTimeout(() => setOpen(false), 600));
            }}
          >
            {copied ? <Check className="size-4 text-up" aria-hidden /> : <Link2 className="size-4 text-text-2" aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
