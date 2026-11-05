"use client";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { BACKEND_URL, RELAYER_URL } from "@/lib/config";
import { RefreshIcon } from "@/components/ui";

/**
 * A quiet line under the top bar while something the app depends on is out of reach: this
 * device's connection, Tredio's API or the relayer that sends trades. Each probe retries before it
 * counts, so a single dropped request never shows it.
 */

const PROBE = { refetchInterval: 30_000, retry: 2, retryDelay: 1_500, staleTime: 10_000, refetchOnWindowFocus: true } as const;

async function reachable(url: string): Promise<true> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
    // Any answer means it is reachable; its health is the status page's business.
    void res.body?.cancel();
  } catch {
    throw new Error(`${url} is unreachable`);
  }
  return true;
}

function subscribeOnline(notify: () => void) {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

export function useConnectivity() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const api = useQuery({ queryKey: ["probe", "api"], queryFn: () => reachable(`${BACKEND_URL}/live`), ...PROBE, enabled: online });
  const relayer = useQuery({ queryKey: ["probe", "relayer"], queryFn: () => reachable(`${RELAYER_URL}/live`), ...PROBE, enabled: online });
  // Down from a failed check (after its retries) until one succeeds again.
  return { online, api: !api.isError, relayer: !relayer.isError };
}

function message(c: ReturnType<typeof useConnectivity>): { title: string; body: string } | null {
  if (!c.online) return { title: "You are offline.", body: "Prices and balances resume when your connection is back." };
  const out = [!c.api && "Tredio's API", !c.relayer && "the relayer that sends trades"].filter(Boolean) as string[];
  if (out.length === 0) return null;
  const what = out.length === 1 ? out[0]! : `${out.slice(0, -1).join(", ")} and ${out[out.length - 1]}`;
  const effects = [
    !c.api && "markets, history and Autopilot may be out of date",
    !c.relayer && "trades cannot be sent for now",
  ].filter(Boolean) as string[];
  return { title: `${what.charAt(0).toUpperCase()}${what.slice(1)} ${out.length === 1 ? "is" : "are"} not answering.`, body: `${effects.join("; ").replace(/^\w/, (x) => x.toUpperCase())}. Your funds are safe.` };
}

export default function ConnectionBanner() {
  const c = useConnectivity();
  const qc = useQueryClient();
  const checking = useIsFetching({ queryKey: ["probe"] }) > 0;
  const m = message(c);
  if (!m) return null;
  const retry = () => {
    // Probe again, then refresh everything that failed meanwhile.
    void qc.refetchQueries({ queryKey: ["probe"] }).then(() => qc.invalidateQueries({ predicate: (q) => q.state.status === "error" }));
  };
  return (
    <div role="status" aria-live="polite" data-testid="connection-banner" className="mb-4 flex items-start gap-3 rounded-2xl border border-[color:var(--warn-soft)] bg-warn-soft px-4 py-3 lg:mb-6">
      <CloudOff className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-text-2">
        <span className="font-strong text-text">{m.title}</span> {m.body}
      </p>
      {c.online ? (
        <button
          type="button"
          onClick={retry}
          disabled={checking}
          className="-my-1 flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 font-strong text-[12.5px] text-text transition-colors hover:bg-[color:var(--warn-soft)] disabled:opacity-60"
        >
          <RefreshIcon spinning={checking} className="size-3.5" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
