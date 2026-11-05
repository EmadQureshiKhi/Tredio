"use client";
import { Bell, BellRing, Fingerprint, X } from "lucide-react";
import { useState } from "react";
import { Button, cn, Field, Segmented, Sheet } from "@/components/ui";
import { baseIdentifier, trendName } from "@/lib/trends";
import type { NewAlert, Trend } from "@/lib/api";
import { describeAlert, useAlerts } from "./useAlerts";

type Mode = "move" | "level";
type Direction = "up" | "down";

const WINDOWS = [
  { value: "15", label: "15 min" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "1440", label: "1 day" },
] as const;
type Window = (typeof WINDOWS)[number]["value"];
const PRESETS = [10, 20, 50];

/**
 * "Alert me" on a trend: a push when its attention rises or drops by a percentage within a window,
 * or crosses a level. Lists the alerts already set on this topic, each removable.
 */
export function AlertSheet({ trend, index, open, onOpenChange }: { trend: Trend; index: number; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { list, create, remove, authenticated, login } = useAlerts();
  const [mode, setMode] = useState<Mode>("move");
  const [direction, setDirection] = useState<Direction>("up");
  const [pct, setPct] = useState("20");
  const [win, setWin] = useState<Window>("60");
  const [level, setLevel] = useState(() => String(Math.min(95, Math.max(5, Math.round(index / 5) * 5 + 5))));
  const name = trendName(trend);
  const base = baseIdentifier(trend.identifier);
  const mine = (list.data?.alerts ?? []).filter((a) => a.trend === base);
  const full = list.data ? list.data.alerts.length >= list.data.max : false;

  const pctValue = Number(pct);
  const levelValue = Number(level);
  const pctError = mode === "move" && pct !== "" && !(pctValue >= 5 && pctValue <= 500) ? "Between 5% and 500%" : null;
  const levelError = mode === "level" && level !== "" && !(levelValue > 0 && levelValue < 100) ? "Between 1 and 99" : null;
  const ready = mode === "move" ? pct !== "" && !pctError : level !== "" && !levelError;
  const above = mode === "level" && levelValue > index;
  const draft: NewAlert =
    mode === "move"
      ? { trend: base, kind: direction === "up" ? "rise" : "drop", changePct: pctValue, windowMin: Number(win) }
      : { trend: base, kind: above ? "above" : "below", level: levelValue };
  // A number and its unit never split across lines ("1 hour", "20%").
  const sentence = ready
    ? `You'll hear when ${name}'s attention ${describeAlert({ changePct: null, windowMin: null, level: null, ...draft })
        .toLowerCase()
        .replace(/(\d+) (min|hours?|days?)/, "$1\u00a0$2")}.`
    : "";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Alert me on ${name}`}
      description="A notification on this device when its attention moves. An alert follows the topic, even if it lists again."
      testId="alert-sheet"
      busy={create.isPending}
      footer={
        authenticated ? (
          <Button block size="lg" disabled={!ready || full} loading={create.isPending} icon={<BellRing className="size-4" aria-hidden />} onClick={() => create.mutate({ ...draft, name })} data-testid="alert-save">
            {full ? `You have ${list.data?.max} alerts` : "Set alert"}
          </Button>
        ) : (
          <Button block size="lg" icon={<Fingerprint className="size-4" aria-hidden />} onClick={login}>
            Sign in to set alerts
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-5">
        <Segmented
          label="Alert type"
          value={mode}
          onChange={setMode}
          options={[
            { value: "move", label: "Moves by" },
            { value: "level", label: "Crosses a level" },
          ]}
        />

        {mode === "move" ? (
          <div className="flex flex-col gap-4">
            <Segmented
              label="Direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "up", label: "Rises", tone: "up" },
                { value: "down", label: "Drops", tone: "down" },
              ]}
            />
            <Field
              label="By"
              inputMode="decimal"
              value={pct}
              onChange={(e) => setPct(e.target.value.replace(/[^\d.]/g, ""))}
              suffix="%"
              error={pctError}
              action={
                <span className="flex gap-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPct(String(p))}
                      className={cn("h-6 rounded-full border px-2 font-strong text-[11.5px] transition-colors", pctValue === p ? "border-transparent bg-text text-bg" : "border-line text-text-2 hover:text-text")}
                    >
                      {p}%
                    </button>
                  ))}
                </span>
              }
              data-testid="alert-pct"
            />
            <div className="flex flex-col gap-1.5">
              <p className="font-strong text-[12.5px] text-text-2">Within</p>
              <Segmented label="Window" size="sm" value={win} onChange={setWin} options={WINDOWS} />
            </div>
          </div>
        ) : (
          <Field
            label="Level"
            inputMode="decimal"
            value={level}
            onChange={(e) => setLevel(e.target.value.replace(/[^\d.]/g, ""))}
            error={levelError}
            hint={`Now ${index.toFixed(2)}. A level above that alerts on a rise past it, one below on a fall.`}
            data-testid="alert-level"
          />
        )}

        {sentence ? (
          <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] leading-5 text-text-2" data-testid="alert-sentence">
            <Bell className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            {sentence}
          </p>
        ) : null}

        {mine.length > 0 ? (
          <section className="flex flex-col gap-2" aria-label={`Your alerts on ${name}`}>
            <h3 className="font-strong text-[12.5px] text-text-2">Your alerts here</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {mine.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] text-text">{describeAlert(a)}</span>
                    <span className="block text-[12px] text-text-3">{a.firedCount > 0 ? `Fired ${a.firedCount} ${a.firedCount === 1 ? "time" : "times"}` : "Not fired yet"}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => remove.mutate(a.id)}
                    aria-label={`Remove alert: ${describeAlert(a)}`}
                    className="grid size-8 shrink-0 place-items-center rounded-full text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}

/** The trend page's Alert button: opens the sheet, and shows how many alerts are set here. */
export function AlertButton({ trend, index }: { trend: Trend; index: number }) {
  const [open, setOpen] = useState(false);
  const { list } = useAlerts();
  const count = (list.data?.alerts ?? []).filter((a) => a.trend === baseIdentifier(trend.identifier)).length;
  return (
    <>
      <Button tone="secondary" size="sm" icon={count > 0 ? <BellRing className="size-3.5 text-primary" aria-hidden /> : <Bell className="size-3.5" aria-hidden />} onClick={() => setOpen(true)} data-testid="alert-open">
        {count > 0 ? `Alerts · ${count}` : "Alert"}
      </Button>
      <AlertSheet trend={trend} index={index} open={open} onOpenChange={setOpen} />
    </>
  );
}
