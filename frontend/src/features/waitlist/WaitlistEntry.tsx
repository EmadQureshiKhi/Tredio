"use client";
import { Check, ChevronRight, Rocket } from "lucide-react";
import { cn } from "@/components/ui";
import { useSheets } from "@/lib/sheets";
import { shortEmail } from "./email";
import { joinedFor, useWaitlistMemory } from "./store";

/**
 * Apart from Waitlist.tsx because the account sheet renders it, and that sheet sits under the
 * account provider the rest of the waitlist reads.
 */

/** Phones: the waitlist's line in the account sheet, which closes before the waitlist opens. */
export function WaitlistEntry({ account, onOpen }: { account: string; onOpen: () => void }) {
  const open = useSheets((s) => s.open);
  const joined = joinedFor(useWaitlistMemory(), account);
  return (
    <button
      type="button"
      onClick={() => {
        onOpen();
        open("waitlist");
      }}
      className="flex w-full items-center gap-3 rounded-2xl border border-line p-4 text-left transition-colors hover:border-line-strong lg:hidden"
      data-testid="waitlist-entry"
    >
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", joined ? "bg-up-soft text-up" : "bg-primary-soft text-primary")}>
        {joined ? <Check className="size-[18px]" aria-hidden /> : <Rocket className="size-[18px]" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-strong text-[14px] leading-5 text-text">{joined ? "On the Mainnet waitlist" : "Join the Mainnet waitlist"}</span>
        <span className="block truncate text-[12.5px] leading-[18px] text-text-2">{joined ? shortEmail(joined.email, 34) : "Early access to the Mainnet beta"}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-text-3" aria-hidden />
    </button>
  );
}
