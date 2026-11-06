"use client";
import { Loader2 } from "lucide-react";
import { explorerTx } from "@/lib/config";
import type { Tx } from "@/lib/trade/useTx";
import { cn } from "./cn";
import { DrawnCheck } from "./DrawnCheck";
import { ExplorerLink } from "./ExplorerLink";
import { ErrorNote } from "./State";

/** Each stage's content fades in where the last one stood; the row itself never moves. */
const ENTER = "transition-opacity duration-200 ease-out starting:opacity-0";

/**
 * A transaction's progress in one line: sending, filled (with how fast), then final. The row
 * eases in, its colour settles from neutral to green, and each check draws itself. Failures show
 * as an error note, with the transaction on NearBlocks when it reached the chain. Renders nothing
 * while idle.
 */
export function TxStatus({ tx, filledLabel = "Filled", className, testId = "tx-status" }: { tx: Tx; filledLabel?: string; className?: string; testId?: string }) {
  const { stage, hash, error, fillMs, inline } = tx;
  if (stage === "idle") return null;
  if (stage === "failed") {
    return (
      <div ref={inline} data-testid={testId} data-stage="failed" className={cn("flex flex-col gap-2", ENTER, className)}>
        <ErrorNote message={error ?? "The transaction failed."} />
        {hash ? <ExplorerLink href={explorerTx(hash)} className="self-start px-1 text-[12.5px]" /> : null}
      </div>
    );
  }
  const final = stage === "final";
  return (
    <div
      ref={inline}
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-stage={stage}
      className={cn(
        "flex h-11 items-center gap-3 overflow-hidden rounded-xl border px-3.5 text-[13px] transition-[height,opacity,background-color,border-color] duration-300 ease-out starting:h-0 starting:opacity-0",
        final ? "border-transparent bg-up-soft" : "border-line bg-surface-2",
        className,
      )}
    >
      {stage === "pending" ? (
        <span key="pending" className={cn("flex items-center gap-3", ENTER)}>
          <Loader2 className="size-4 shrink-0 animate-spin text-text-2" aria-hidden />
          <span className="text-text-2">Sending to NEAR</span>
        </span>
      ) : (
        <>
          <DrawnCheck key={final ? "final" : "filled"} double={final} className="text-up" />
          <span className="whitespace-nowrap font-strong text-text">
            {filledLabel}
            {fillMs !== null ? <span className="num font-sans text-text-2"> in {(fillMs / 1000).toFixed(1)}s</span> : null}
          </span>
          <span key={final ? "final" : "finalizing"} className={cn("flex items-center gap-1.5 whitespace-nowrap", ENTER, final ? "text-up" : "text-text-3")}>
            {final ? null : <span className="live-dot size-1.5 rounded-full bg-text-3" aria-hidden />}
            {final ? "Final" : "Finalizing"}
          </span>
          {hash ? <ExplorerLink href={explorerTx(hash)} size="short" className={cn("ml-auto whitespace-nowrap", ENTER)} /> : null}
        </>
      )}
    </div>
  );
}
