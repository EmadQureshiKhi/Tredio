"use client";
import { type ReactNode, startTransition, useEffect, useState } from "react";
// A namespace read, since only Next's bundled React (canary) exports it; plain React would fail to import it.
import * as React from "react";

const { ViewTransition } = React;

/**
 * A skeleton handing over to its content: once `ready` turns true, the swap runs as a transition,
 * so the skeleton leaves quickly and the content settles in (.reveal-out and .reveal-in in
 * globals.css). Content that is ready on the first render (a cached page) shows at once, and a
 * page arriving by navigation animates as a whole instead.
 */
export function Reveal({ ready, fallback, children, className }: { ready: boolean; fallback: ReactNode; children: ReactNode; className?: string }) {
  const [shown, setShown] = useState(ready);
  useEffect(() => {
    if (ready && !shown) startTransition(() => setShown(true));
  }, [ready, shown]);
  if (ready && shown) {
    return (
      <ViewTransition enter="reveal-in" default="none">
        <div className={className}>{children}</div>
      </ViewTransition>
    );
  }
  return (
    <ViewTransition exit="reveal-out" default="none">
      <div className={className}>{fallback}</div>
    </ViewTransition>
  );
}
