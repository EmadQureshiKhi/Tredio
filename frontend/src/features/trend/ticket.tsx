"use client";
import { Fingerprint } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useState } from "react";
import { Button, cn, Field } from "@/components/ui";
import type { ButtonTone } from "@/components/ui/Button";
import { useAccount } from "@/lib/account/AccountProvider";
import { tokenAmount } from "@/lib/format";
import { formatAmount } from "./math";

/** Building blocks shared by the trend page's tickets. */

/** The current time, ticking every `ms` (for countdowns). */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** An amount input with the spendable balance and a Max shortcut. */
export function AmountField({
  label,
  value,
  onChange,
  unit,
  balance,
  decimals,
  error,
  hint,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  balance?: bigint | null;
  decimals: number;
  error?: string | null;
  hint?: ReactNode;
  testId?: string;
}) {
  const max = balance !== undefined && balance !== null && balance > 0n ? formatAmount(balance, decimals, Math.min(decimals, 6)) : null;
  return (
    <Field
      label={label}
      inputMode="decimal"
      autoComplete="off"
      placeholder="0.00"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))}
      suffix={unit}
      error={error}
      hint={hint}
      reserveNote
      data-testid={testId}
      action={
        balance !== undefined && balance !== null ? (
          <button type="button" disabled={!max} onClick={() => max && onChange(max)} className="num text-[12px] text-text-3 transition-colors enabled:hover:text-text disabled:cursor-default">
            Balance {tokenAmount(balance, decimals)}
            {max ? <span className="ml-1.5 font-strong text-primary">Max</span> : null}
          </button>
        ) : undefined
      }
    />
  );
}

/** The ticket's main button, or Sign in when signed out. `passkey` marks a trade the passkey confirms. */
export function SubmitButton({ children, tone = "primary", disabled, loading, onClick, testId, passkey }: { children: ReactNode; tone?: ButtonTone; disabled?: boolean; loading?: boolean; onClick: () => void; testId?: string; passkey?: boolean }) {
  const account = useAccount();
  // Restoring the session: a neutral placeholder, never a "Sign in" that turns into the trade.
  if (account.status === "loading") return <div className="skeleton h-12 w-full rounded-2xl" aria-hidden />;
  if (!account.authenticated) {
    return (
      <Button block size="lg" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={account.login}>
        {account.status === "session-expired" ? (account.upgradeRequired ? "Upgrade account to trade" : "Renew session to trade") : "Sign in to trade"}
      </Button>
    );
  }
  return (
    <Button block size="lg" tone={tone} disabled={disabled} loading={loading} onClick={onClick} data-testid={testId} icon={passkey ? <Fingerprint className="size-[18px]" aria-hidden /> : undefined}>
      {children}
    </Button>
  );
}

/** A quiet panel of explanation or risk, under a ticket. */
export function Note({ children, tone = "muted", className }: { children: ReactNode; tone?: "muted" | "warn"; className?: string }) {
  return <p className={cn("rounded-xl px-3.5 py-2.5 text-[12.5px] leading-[18px]", tone === "warn" ? "bg-warn-soft text-text" : "bg-surface-2 text-text-2", className)}>{children}</p>;
}

/** A sub-heading inside a ticket. */
export function Section({ title, action, children, className, ref }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; ref?: Ref<HTMLElement> }) {
  return (
    <section ref={ref} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-strong text-[13px] text-text-2">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
