"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLenis } from "lenis/react";
import WaitlistForm from "./WaitlistForm";

/**
 * The Mainnet waitlist modal, opened from anywhere on the site with `useWaitlist().open()`. It
 * stops the smooth scroll and traps focus while open, closes on Escape or a click outside, and
 * returns focus to whatever opened it.
 */

const WaitlistContext = createContext({ open: () => {} });

export const useWaitlist = () => useContext(WaitlistContext);

export function WaitlistProvider({ children }) {
  const [open, setOpen] = useState(false);
  const opener = useRef(null);
  const show = useCallback(() => {
    opener.current = document.activeElement;
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
    opener.current?.focus?.();
  }, []);
  return (
    <WaitlistContext.Provider value={{ open: show }}>
      {children}
      {open && <WaitlistModal onClose={hide} />}
    </WaitlistContext.Provider>
  );
}

function WaitlistModal({ onClose }) {
  const lenis = useLenis();
  const panel = useRef(null);

  useEffect(() => {
    lenis?.stop();
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      lenis?.start();
      document.documentElement.style.overflow = overflow;
    };
  }, [lenis]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll("a[href], button:not([disabled]), input:not([tabindex='-1'])")];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100000] flex items-end justify-center sm:items-center sm:p-6" data-lenis-prevent>
      <div aria-hidden="true" onClick={onClose} className="waitlist-fade absolute inset-0 bg-black/70 backdrop-blur-[3px]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="waitlist-title"
        aria-describedby="waitlist-intro"
        className="waitlist-rise relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[22px] border border-white/10 bg-[#121214] px-6 pb-[max(28px,env(safe-area-inset-bottom))] pt-7 text-white shadow-2xl sm:max-w-[460px] sm:rounded-[22px] sm:p-8"
        data-testid="waitlist-modal"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex size-9 cursor-pointer items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
        <span className="inline-flex items-center gap-2 rounded-full border border-[#9C93E8]/30 bg-[#9C93E8]/10 px-3 py-1 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-[#C9C3F5]">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-[#9C93E8]" />
          Mainnet waitlist
        </span>
        <h2 id="waitlist-title" className="mt-4 pr-8 font-third text-[30px] leading-[1.1]">
          Be first on Mainnet
        </h2>
        <p id="waitlist-intro" className="mt-3 text-pretty font-body text-[15px] leading-[1.6] text-white/70">
          Tredio is live on Testnet. Leave your email to hear the moment Mainnet opens and to get early access to the beta.
        </p>
        <div className="mt-6">
          <WaitlistForm tone="dark" autoFocus />
        </div>
      </div>
    </div>
  );
}
