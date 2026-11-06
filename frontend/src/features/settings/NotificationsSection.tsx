"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, BellRing, Fingerprint, Smartphone } from "lucide-react";
import { useState } from "react";
import { Badge, Button, ErrorNote, Skeleton, Switch } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiSignIn } from "@/lib/account/ApiSignIn";
import { currentSubscription, disablePush, enablePush, PUSH_TOPICS, type PushTopic, pushSupport, setPushTopics, storedTopics } from "@/lib/push";
import { notify } from "@/lib/toast";
import { Section } from "./Section";

/** Push notifications on this device: turn on, pick topics, turn off. */
export function NotificationsSection() {
  const account = useAccount();
  return (
    <Section id="notifications" title="Notifications" description="Alerts on this device when something you care about moves, even with Tredio closed. Each device is set up on its own.">
      {!account.authenticated ? (
        <Button onClick={account.login} icon={<Fingerprint className="size-4" aria-hidden />}>
          Sign in
        </Button>
      ) : (
        <Push />
      )}
    </Section>
  );
}

function Push() {
  const account = useAccount();
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["push-state", account.address],
    queryFn: async () => {
      const support = pushSupport();
      const permission = support === "supported" ? Notification.permission : "default";
      const sub = support === "supported" ? await currentSubscription() : null;
      return { support, permission, on: Boolean(sub) };
    },
  });
  const [topics, setTopics] = useState<PushTopic[]>(() => (typeof window === "undefined" ? PUSH_TOPICS.map((t) => t.value) : storedTopics()));
  const refresh = () => qc.invalidateQueries({ queryKey: ["push-state", account.address] });
  const enable = useMutation({ mutationFn: () => enablePush(topics), onSuccess: () => notify.success("Notifications on", "This device gets alerts even with Tredio closed."), onSettled: refresh });
  const disable = useMutation({ mutationFn: () => disablePush(), onSuccess: () => notify.success("Notifications off", "This device gets no more alerts."), onSettled: refresh });
  const change = useMutation({
    mutationFn: (next: PushTopic[]) => setPushTopics(next),
    onMutate: (next) => {
      const prev = topics;
      setTopics(next);
      return { prev };
    },
    onError: (_e, _n, ctx) => ctx && setTopics(ctx.prev),
  });

  if (state.isLoading || !state.data) return <Skeleton className="h-24 rounded-2xl" />;
  const { support, permission, on } = state.data;

  if (support === "install-first") {
    return (
      <div className="flex gap-3 rounded-2xl border border-line p-4">
        <Smartphone className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <p className="text-[13.5px] leading-5 text-text-2">On iPhone and iPad, notifications work from the installed app: tap Share, then Add to Home Screen, and open Tredio from there.</p>
      </div>
    );
  }
  if (support === "unsupported") return <p className="text-[13.5px] text-text-2">This browser cannot receive push notifications.</p>;

  const error = enable.error ?? disable.error ?? change.error;
  return (
    <div className="flex flex-col gap-4" data-testid="push" data-on={on}>
      {account.kind === "wallet" ? <ApiSignIn purpose="so alerts reach this device" /> : null}
      <div className="flex flex-col gap-3 rounded-2xl border border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {on ? <BellRing className="mt-0.5 size-[18px] shrink-0 text-up" aria-hidden /> : <BellOff className="mt-0.5 size-[18px] shrink-0 text-text-3" aria-hidden />}
          <div>
            <p className="flex items-center gap-2 font-strong text-[14px] text-text">
              {on ? "On for this device" : "Off on this device"}
              {permission === "denied" ? <Badge tone="warn">Blocked</Badge> : null}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-[18px] text-text-3">
              {permission === "denied" ? "The browser blocks notifications for Tredio. Allow them in its site settings, then turn them on here." : on ? "Pick what reaches you below." : "Your browser asks for permission first."}
            </p>
          </div>
        </div>
        {on ? (
          <Button tone="secondary" loading={disable.isPending} onClick={() => disable.mutate()} data-testid="push-off" className="shrink-0">
            Turn off
          </Button>
        ) : (
          <Button loading={enable.isPending} disabled={!account.backendReady || permission === "denied"} onClick={() => enable.mutate()} data-testid="push-on" className="shrink-0">
            Turn on
          </Button>
        )}
      </div>
      {error ? <ErrorNote message={error instanceof Error ? error.message : "Notifications could not be changed."} /> : null}
      {!on ? (
        <p className="text-[12.5px] leading-[18px] text-text-3">Once on, choose what reaches you: {PUSH_TOPICS.map((t) => t.label.toLowerCase()).join(", ")}.</p>
      ) : null}
      <fieldset disabled={change.isPending} className={on ? "flex flex-col" : "hidden"}>
        <legend className="sr-only">Topics</legend>
        {PUSH_TOPICS.map((t) => {
          const checked = topics.includes(t.value);
          return (
            <div key={t.value} className="flex items-center justify-between gap-4 border-t border-line py-3 first:border-t-0">
              <div className="min-w-0">
                <p className="font-strong text-[13.5px] text-text">{t.label}</p>
                <p className="text-[12.5px] leading-[18px] text-text-3">{t.hint}</p>
              </div>
              <Switch
                label={`${t.label} notifications`}
                checked={checked}
                disabled={!on || (checked && topics.length === 1)}
                onChange={(v) => change.mutate(v ? [...topics, t.value] : topics.filter((x) => x !== t.value))}
              />
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}
