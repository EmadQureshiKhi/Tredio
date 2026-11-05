"use client";
import { Bell, Fingerprint, X } from "lucide-react";
import Link from "next/link";
import { Button, ErrorNote, Skeleton } from "@/components/ui";
import { FORWARD } from "@/components/shell/PageTransition";
import { describeAlert, useAlerts } from "@/features/alerts/useAlerts";
import { ago } from "@/lib/format";
import { Section } from "./Section";

/** Every attention alert this account set, with when each last fired, removable. */
export function AlertsSection() {
  const { list, remove, authenticated, login } = useAlerts();
  const items = list.data?.alerts ?? [];
  return (
    <Section
      id="alerts"
      title="Attention alerts"
      description="Set one from any trend page with the Alert button. Each one notifies this account's devices that take attention alerts."
    >
      {!authenticated ? (
        <Button onClick={login} icon={<Fingerprint className="size-4" aria-hidden />}>
          Sign in
        </Button>
      ) : list.isError ? (
        <ErrorNote message="Your alerts could not load." onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : items.length === 0 ? (
        <p className="flex items-center gap-2 text-[13.5px] text-text-3">
          <Bell className="size-4" aria-hidden />
          No alerts yet.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" data-testid="alerts-list">
          {items.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                {a.identifier ? (
                  <Link href={`/t/${a.identifier}`} transitionTypes={FORWARD} className="block truncate font-strong text-[13.5px] text-text hover:underline">
                    {a.name}
                  </Link>
                ) : (
                  <span className="block truncate font-strong text-[13.5px] text-text">{a.name}</span>
                )}
                <p className="truncate text-[12.5px] text-text-3">
                  {describeAlert(a)}
                  {" · "}
                  {!a.identifier ? "waits until it lists again" : a.lastFiredAt ? `last fired ${ago(Date.parse(a.lastFiredAt) / 1000)}` : "not fired yet"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove.mutate(a.id)}
                aria-label={`Remove alert on ${a.name}: ${describeAlert(a)}`}
                className="grid size-8 shrink-0 place-items-center rounded-full text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.data ? <p className="mt-3 text-[12px] text-text-3">{`${items.length} of ${list.data.max} alerts`}</p> : null}
    </Section>
  );
}
