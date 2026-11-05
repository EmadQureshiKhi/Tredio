import type { ReactNode } from "react";
// A namespace read, since only Next's bundled React (canary) exports it; plain React would fail to import it.
import * as React from "react";

const { ViewTransition } = React;

/**
 * How a page arrives and leaves (React's <ViewTransition>, animated in globals.css). Every page
 * wraps its content in this, in its own page.tsx: a layout persists across navigations, so its
 * enter and exit never fire. Links name the direction with `transitionTypes`: "nav-forward"
 * (into a trend or a rule) slides in from the right, "nav-back" (a page's back link) from the
 * left, and any other navigation crossfades. Shared elements (a trend card's name, index and
 * sparkline) morph on their own; nothing else animates when only part of a page changes.
 */
const MOTION = { "nav-forward": "nav-forward", "nav-back": "nav-back", default: "page-fade" };

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter={MOTION} exit={MOTION} default="none">
      <div>{children}</div>
    </ViewTransition>
  );
}

/** The types a link passes to name its direction. */
export const FORWARD = ["nav-forward"];
export const BACK = ["nav-back"];
