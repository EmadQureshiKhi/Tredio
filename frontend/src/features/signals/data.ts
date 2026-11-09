"use client";
import { useQuery } from "@tanstack/react-query";
import { openSignal } from "@tredio/autopilot";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, type SignalBody, type SignalChannel, type SignalItem, signals } from "@/lib/api";
import { shortAddress } from "@/lib/format";

/**
 * Paid signals in the app: channels, the feed, early access, and opening sealed signals in the
 * browser with the viewing keys the account holds (backend/src/signals, packages/autopilot/src/signals.ts).
 */

export const SIGNALS_PREFIX = "signals:";
export const isSignalLeader = (leader: string) => leader.startsWith(SIGNALS_PREFIX);
export const signalIdentity = (leader: string) => leader.slice(SIGNALS_PREFIX.length);
export const channelName = (c: Pick<SignalChannel, "handle" | "leader"> | null | undefined, identity?: string) => (c?.handle ? `@${c.handle}` : shortAddress(c?.leader ?? identity ?? ""));

/** The server answers 503 when signals are off; the app then leaves them out instead of showing an error. */
const off = (e: unknown) => e instanceof ApiError && e.status === 503;

export function useSignalChannels() {
  const q = useQuery({ queryKey: ["signal-channels"], queryFn: () => signals.channels(), refetchInterval: 60_000, retry: (n, e) => !off(e) && n < 1 });
  return { ...q, off: off(q.error) };
}

export function useSignalFeed(leader?: string) {
  const q = useQuery({ queryKey: ["signal-feed", leader ?? "all"], queryFn: () => signals.feed(leader), refetchInterval: 30_000, retry: (n, e) => !off(e) && n < 1 });
  return { ...q, off: off(q.error) };
}

export function useSignalAccess(leader: string | null) {
  const { address, backendReady } = useAccount();
  return useQuery({ queryKey: ["signal-access", leader, address], queryFn: () => signals.access(leader!), enabled: Boolean(leader) && backendReady && Boolean(address), refetchInterval: 60_000 });
}

/**
 * The signals this account can read early, opened here: the API hands out the viewing keys for the
 * weeks its access covers (all recent weeks for the leader's own account), and each sealed signal
 * opens only under its week's key and its own commitment.
 */
export function useOpenedSignals(leader: string, items: SignalItem[] | undefined, canRead: boolean) {
  const { address, backendReady } = useAccount();
  const sealed = (items ?? []).filter((s) => !s.signal);
  return useQuery({
    queryKey: ["signal-opened", leader, address, sealed.map((s) => s.id).join(",")],
    enabled: canRead && backendReady && Boolean(address) && sealed.length > 0,
    queryFn: async () => {
      const { keys } = await signals.keys(leader);
      const byEpoch = new Map(keys.map((k) => [k.epoch, k.key]));
      const opened = new Map<number, SignalBody>();
      for (const s of sealed) {
        const key = byEpoch.get(s.epoch);
        if (!key) continue;
        const body = await openSignal(key, { iv: s.iv, ciphertext: s.ciphertext }, s.commitment).catch(() => null);
        if (body) opened.set(s.id, body);
      }
      return opened;
    },
    staleTime: 60_000,
  });
}

export const days = (sec: number) => {
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h`;
  const d = Math.round(sec / 86_400);
  return `${d} day${d === 1 ? "" : "s"}`;
};
