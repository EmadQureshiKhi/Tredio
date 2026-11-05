"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Check, Fingerprint, KeyRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, ErrorNote, Segmented, Sheet, Skeleton } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, social, type Trend } from "@/lib/api";
import { useTrends } from "@/lib/hooks/queries";
import { callMessage, type Horizon, signAsCaller } from "@/lib/social";
import { ShareActions } from "@/features/share/ShareActions";
import { callSharePath } from "@/features/share/share";
import { SelectPill, TextArea } from "@/features/autopilot/shared/kit";
import { baseIdentifier, trendName } from "@/lib/trends";
import { useCallerIdentity } from "./identity";

/**
 * Making a call: up or down on a live trend's attention over 24 hours or 7 days, signed by the
 * caller identity (no prompt) and resolved by the oracle's own checkpoints.
 */
export function CallSheet({ open, onOpenChange, trend }: { open: boolean; onOpenChange: (o: boolean) => void; trend?: string }) {
  const [round, setRound] = useState(0);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(() => setRound((r) => r + 1), 250);
      }}
      testId="call-sheet"
      title="Make a call"
      description="Say where a trend's attention goes next. Calls are public, signed, and scored when they resolve."
    >
      <CallForm key={round} initialTrend={trend} onAnother={() => setRound((r) => r + 1)} />
    </Sheet>
  );
}

function CallForm({ initialTrend, onAnother }: { initialTrend?: string; onAnother: () => void }) {
  const account = useAccount();
  const me = useCallerIdentity();
  const trends = useTrends();
  const qc = useQueryClient();
  const live = useMemo(() => [...(trends.data?.trends ?? [])].filter((t) => t.status === "active" || t.status === "cooling").sort((a, b) => b.index - a.index), [trends.data]);
  const [picked, setPicked] = useState<string | null>(initialTrend ?? null);
  const identifier = picked ?? live[0]?.identifier ?? "";
  const trend: Trend | undefined = live.find((t) => t.identifier === identifier);
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [horizon, setHorizon] = useState<"86400" | "604800">("86400");
  const [note, setNote] = useState("");

  const post = useMutation({
    mutationFn: async () => {
      if (!me.identity) throw new Error("Unlock your caller identity first.");
      const horizonSec = Number(horizon) as Horizon;
      const body = note.trim();
      const signed = await signAsCaller(me.identity, (issuedAt) => callMessage({ identifier, direction, horizonSec, note: body, issuedAt }));
      return social.call({ caller: signed.caller, identifier, direction, horizonSec, note: body, issuedAt: signed.issuedAt, signature: signed.signature });
    },
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["caller"] }), qc.invalidateQueries({ queryKey: ["callers-leaderboard"] })]),
    onError: (e) => me.failed(e),
  });

  if (!account.authenticated) {
    return (
      <Button block size="lg" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={account.login}>
        Sign in to make calls
      </Button>
    );
  }
  if (me.checking) return <Skeleton className="h-64 rounded-2xl" />;
  if (!me.identity) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex gap-3 rounded-2xl border border-line p-4">
          <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          <p className="text-[13.5px] leading-5 text-text-2">Calls are signed by your caller identity, a key your passkey derives apart from your trading account. This device needs it once: one passkey prompt.</p>
        </div>
        {me.unlockError ? <ErrorNote message={me.unlockError} /> : null}
        <Button block size="lg" loading={me.unlocking} icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={me.unlock}>
          Unlock with passkey
        </Button>
      </div>
    );
  }

  if (post.data) {
    const c = post.data.call;
    const name = trend ? trendName(trend) : baseIdentifier(identifier);
    return (
      <div className="flex flex-col gap-4" data-testid="call-done">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-6 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-up-soft text-up">
            <Check className="size-5" aria-hidden />
          </span>
          <p className="font-strong text-[15px] text-text">
            {direction === "up" ? "Up" : "Down"} on {name}
          </p>
          <p className="max-w-xs text-[13px] leading-5 text-text-2">
            Opened at <span className="num text-text">{c.openingIndex.toFixed(2)}</span> points. It resolves {new Date(c.resolvesAt * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.
          </p>
        </div>
        <ShareActions text={`I called ${name} ${direction} on Tredio.`} path={callSharePath(identifier, c.id)} />
        <div className="flex flex-wrap gap-2">
          <Link href={`/c/${me.address}`} className="font-strong text-[13.5px] text-primary underline-offset-4 hover:underline">
            See it on your profile
          </Link>
          <span className="text-text-3">·</span>
          <button type="button" onClick={onAnother} className="font-strong text-[13.5px] text-text-2 underline-offset-4 hover:text-text hover:underline">
            Make another call
          </button>
        </div>
      </div>
    );
  }

  const hours = horizon === "86400" ? "24 hours" : "7 days";
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (identifier && note.length <= 280) post.mutate();
      }}
    >
      <div className="flex flex-col gap-2">
        <p className="font-strong text-[12.5px] text-text-2">Trend</p>
        {live.length ? (
          <SelectPill label="Trend" value={identifier} onChange={setPicked} options={live.map((t) => ({ value: t.identifier, label: `${trendName(t)} · ${t.index.toFixed(1)}` }))} className="w-full [&_select]:h-11 [&_select]:w-full" testId="call-trend" />
        ) : (
          <p className="text-[13px] text-text-3">{trends.isLoading ? "Loading live trends" : "No live trends right now."}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">Attention will go</p>
          <Segmented
            label="Direction"
            value={direction}
            onChange={setDirection}
            options={[
              { value: "up", label: "Up", tone: "up" },
              { value: "down", label: "Down", tone: "down" },
            ]}
          />
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">Within</p>
          <Segmented
            label="Horizon"
            value={horizon}
            onChange={setHorizon}
            options={[
              { value: "86400", label: "24h" },
              { value: "604800", label: "7 days" },
            ]}
          />
        </div>
      </div>
      <TextArea label="Why (optional)" value={note} onChange={setNote} max={280} rows={3} placeholder="The thesis in a line or two" testId="call-note" />
      <div className="flex gap-3 rounded-2xl border border-line bg-surface-2 p-4">
        {direction === "up" ? <ArrowUpRight className="mt-0.5 size-[18px] shrink-0 text-up" aria-hidden /> : <ArrowDownRight className="mt-0.5 size-[18px] shrink-0 text-down" aria-hidden />}
        <p className="text-[13px] leading-5 text-text-2">
          {trend ? (
            <>
              Hits if the index is {direction === "up" ? "above" : "at or below"} <span className="num font-strong text-text">{trend.index.toFixed(2)}</span> in {hours}, as the oracle records it.{" "}
            </>
          ) : null}
          Signed by your caller identity, which no one can tie to your trading account unless you link them. Up to 20 calls a day.
        </p>
      </div>
      {post.error ? <ErrorNote message={post.error instanceof ApiError || post.error instanceof Error ? post.error.message : "The call failed."} /> : null}
      <Button type="submit" size="lg" block loading={post.isPending} disabled={!trend || note.length > 280} data-testid="call-submit">
        Sign and post call
      </Button>
    </form>
  );
}
