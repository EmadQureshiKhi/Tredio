"use client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { cn } from "./cn";

/**
 * A refresh icon that spins while `spinning`, and always finishes the turn it is on: a check that
 * answers in 80ms still gets one whole, smooth rotation instead of a twitch.
 */
export function RefreshIcon({ spinning, className }: { spinning: boolean; className?: string }) {
  const [turning, setTurning] = useState(spinning);
  if (spinning && !turning) setTurning(true);
  return <RefreshCw className={cn(className, turning && "animate-spin")} onAnimationIteration={() => !spinning && setTurning(false)} aria-hidden />;
}
