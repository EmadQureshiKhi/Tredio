"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "@/lib/account/AccountProvider";
import { type AttentionAlert, alerts, type NewAlert } from "@/lib/api";
import { ensurePushTopic } from "@/lib/push";
import { notify } from "@/lib/toast";

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const windowLabel = (min: number) => (min % 1440 === 0 ? plural(min / 1440, "day") : min % 60 === 0 ? plural(min / 60, "hour") : `${min} min`);

/** What an alert listens for, in a few words: "Rises 20% within 1 hour", "Falls below 30". */
export function describeAlert(a: Pick<AttentionAlert, "kind" | "changePct" | "windowMin" | "level">): string {
  switch (a.kind) {
    case "rise":
      return `Rises ${a.changePct}% within ${windowLabel(a.windowMin ?? 60)}`;
    case "drop":
      return `Drops ${a.changePct}% within ${windowLabel(a.windowMin ?? 60)}`;
    case "above":
      return `Rises above ${a.level}`;
    case "below":
      return `Falls below ${a.level}`;
  }
}

/**
 * This account's attention alerts: the list, and setting or removing one. Setting one also makes
 * sure this device can hear it: push on, with the alerts topic (the browser asks once).
 */
export function useAlerts() {
  const account = useAccount();
  const qc = useQueryClient();
  const key = ["alerts", account.address ?? null] as const;
  const list = useQuery({ queryKey: key, enabled: account.authenticated, queryFn: () => alerts.list(), staleTime: 30_000 });

  const create = useMutation({
    mutationFn: (a: NewAlert & { name: string }) => alerts.create(a),
    onSuccess: async (r, a) => {
      void qc.invalidateQueries({ queryKey: key });
      const heard = await ensurePushTopic("alerts");
      const what = describeAlert(r.alert).toLowerCase();
      if (r.alreadyPast) notify.info(`Alert set on ${a.name}`, `Attention is already ${r.alert.kind === "above" ? "above" : "below"} ${r.alert.level}, so you'll hear the next time it crosses.`);
      else if (heard) notify.success(`Alert set on ${a.name}`, `You'll get a notification on this device when attention ${what}.`);
      else notify.info(`Alert set on ${a.name}`, "Turn on notifications in Settings to hear it on this device.");
    },
    onError: (e) => notify.error("Could not set the alert", e instanceof Error ? e.message : undefined),
  });

  const remove = useMutation({
    mutationFn: (id: number) => alerts.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<{ alerts: AttentionAlert[]; max: number }>(key);
      if (before) qc.setQueryData(key, { ...before, alerts: before.alerts.filter((x) => x.id !== id) });
      return { before };
    },
    onError: (e, _id, ctx) => {
      qc.setQueryData(key, ctx?.before);
      notify.error("Could not remove the alert", e instanceof Error ? e.message : undefined);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });

  return { list, create, remove, authenticated: account.authenticated, login: account.login };
}
