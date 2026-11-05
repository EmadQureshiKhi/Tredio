"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAccount } from "@/lib/account/AccountProvider";
import { type Candidate, trends } from "@/lib/api";
import { ensurePushTopic } from "@/lib/push";
import { notify } from "@/lib/toast";

/**
 * "Notify me when it lists": the candidates this account waits on, and a toggle. Watching also
 * makes sure this device can hear it: push on, with the markets topic (the browser asks once).
 */
export function useWatch() {
  const account = useAccount();
  const qc = useQueryClient();
  const key = ["radar-watching", account.address ?? null] as const;
  const watching = useQuery({ queryKey: key, enabled: account.authenticated, queryFn: () => trends.watching(), staleTime: 60_000 });
  const ids = useMemo(() => new Set(watching.data?.ids ?? []), [watching.data]);

  const mutation = useMutation({
    mutationFn: ({ c, on }: { c: Candidate; on: boolean }) => trends.watch(c.id, on),
    onMutate: async ({ c, on }) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<{ ids: number[] }>(key);
      qc.setQueryData<{ ids: number[] }>(key, { ids: on ? [...(before?.ids ?? []), c.id] : (before?.ids ?? []).filter((x) => x !== c.id) });
      return { before };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(key, ctx?.before);
      notify.error("Could not update the alert", e instanceof Error ? e.message : undefined);
    },
    onSuccess: async (_r, { c, on }) => {
      void qc.invalidateQueries({ queryKey: ["upcoming"] });
      if (!on) return;
      const heard = await ensurePushTopic("markets");
      if (heard) notify.success(`We'll tell you when ${c.displayName} lists`, "You'll get a notification the moment its market opens, and your wait counts toward community picks.");
      else notify.info(`${c.displayName} is on your list`, "Turn on notifications in Settings to hear the moment it lists.");
    },
  });

  return {
    ids,
    pending: mutation.isPending ? (mutation.variables?.c.id ?? null) : null,
    toggle: (c: Candidate) => {
      if (!account.authenticated) {
        account.login();
        return;
      }
      mutation.mutate({ c, on: !ids.has(c.id) });
    },
  };
}
