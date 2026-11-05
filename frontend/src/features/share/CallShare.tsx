import { ArrowDown, ArrowUp, Clock } from "lucide-react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, type BadgeTone, ButtonLink, Card, Delta } from "@/components/ui";
import { Countdown } from "./Countdown";
import { baseIdentifier, callerName, horizonWords, type SharedCall, trendName } from "./data";
import { ShareActions } from "./ShareActions";
import { callSharePath } from "./share";

const OUTCOME: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: "Open", tone: "neutral" },
  hit: { label: "Hit", tone: "up" },
  miss: { label: "Miss", tone: "down" },
  void: { label: "Void", tone: "neutral" },
};

/** A shared call: who called which way, from where, and how it is going. */
export default function CallShare({ data }: { data: SharedCall }) {
  const { call, trend, record } = data;
  const identifier = call.identifier ?? "";
  const name = trend ? trendName(trend) : baseIdentifier(identifier);
  const up = call.direction === "up";
  const opening = Number(call.opening_index);
  const closing = call.closing_index === null ? null : Number(call.closing_index);
  const shown = closing ?? trend?.index ?? null;
  const move = shown !== null && opening > 0 ? ((shown - opening) / opening) * 100 : null;
  const outcome = OUTCOME[call.outcome] ?? OUTCOME.open!;
  const resolved = record ? record.hits + record.misses : 0;
  const title = `${callerName(call)} called ${up ? "UP" : "DOWN"} on ${name}`;

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 sm:pt-6">
      <p className="font-strong text-[12px] uppercase tracking-[0.14em] text-primary">A call on Tredio</p>
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-5 p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-2.5">
            <Avatar address={call.caller} size={28} />
            <span className="font-strong text-[15px] text-text">{callerName(call)}</span>
            <span className="text-[14px] text-text-2">called</span>
            <Badge tone={up ? "up" : "down"} icon={up ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />}>
              {up ? "UP" : "DOWN"}
            </Badge>
            <span className="text-[14px] text-text-2">over {horizonWords(call.horizon_sec)}</span>
          </div>
          <h1 className="font-display text-[34px] leading-[1.08] text-text sm:text-[44px]">{name}</h1>
          {call.note ? <blockquote className="border-l-2 border-primary pl-4 text-[15px] leading-6 text-text-2">{call.note}</blockquote> : null}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 sm:grid-cols-3">
            <div>
              <dt className="text-[12px] uppercase tracking-[0.08em] text-text-3">Called at</dt>
              <dd className="num-display mt-1 font-display text-[30px] leading-none text-text">{opening.toFixed(2)}</dd>
            </div>
            <div>
              <dt className="text-[12px] uppercase tracking-[0.08em] text-text-3">{closing !== null ? "Closed at" : "Now"}</dt>
              <dd className="mt-1 flex items-baseline gap-2">
                <span className="num-display font-display text-[30px] leading-none text-text">{shown === null ? "-" : shown.toFixed(2)}</span>
                <Delta value={move} className="text-[13px]" />
              </dd>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <dt className="text-[12px] uppercase tracking-[0.08em] text-text-3">Result</dt>
              <dd className="mt-1.5">
                <Badge tone={outcome.tone}>{outcome.label}</Badge>
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-line bg-surface-2/50 px-5 py-3.5 text-[13px] text-text-2 sm:px-7">
          <span>
            {record && resolved > 0 ? (
              <>
                <span className="font-strong text-text">{Math.round(record.hitRate * 100)}% hit rate</span> over {resolved} resolved call{resolved === 1 ? "" : "s"}
              </>
            ) : (
              "This caller's first calls are still open."
            )}
          </span>
          {call.outcome === "open" ? (
            <span className="flex items-center gap-1.5 text-text-3">
              <Clock className="size-3.5" aria-hidden />
              <Countdown untilSec={call.resolves_at} prefix="Resolves in " />
            </span>
          ) : null}
        </div>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ShareActions text={title} path={callSharePath(identifier, call.id)} className="[&>button]:flex-1 sm:[&>button]:flex-none" />
        {identifier ? (
          <ButtonLink href={`/t/${identifier}`} tone="secondary">
            Trade {name}
          </ButtonLink>
        ) : null}
      </div>
    </div>
  );
}
