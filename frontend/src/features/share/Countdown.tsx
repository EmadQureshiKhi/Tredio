"use client";
import { useEffect, useState } from "react";
import { countdown } from "@/lib/format";

/** "4h 12m" until `untilSec`, ticking; "ended" once it passes. */
export function Countdown({ untilSec, prefix = "" }: { untilSec: number; prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const left = countdown(untilSec, now);
  // The server renders its own moment; the browser's clock takes over without a warning.
  return (
    <span className="num" suppressHydrationWarning>
      {left === "ended" ? "resolving now" : `${prefix}${left}`}
    </span>
  );
}
