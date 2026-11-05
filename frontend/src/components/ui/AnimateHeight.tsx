"use client";
import { m, useReducedMotion } from "framer-motion";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "./cn";

const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/**
 * Eases its own height to whatever its content measures, so content that swaps (a ticket, a
 * transaction's status, an expanding section) never jumps. Clips only while it moves, so focus
 * rings and shadows inside stay whole; reduced motion resizes at once.
 */
export function AnimateHeight({ children, className, duration = 0.24 }: { children: ReactNode; className?: string; duration?: number }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  const [moving, setMoving] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry!.borderBoxSize[0]!.blockSize));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <m.div
      className={cn(moving && "overflow-hidden", className)}
      initial={false}
      animate={{ height }}
      transition={{ duration: reduced ? 0 : duration, ease: EASE_OUT }}
      onAnimationStart={() => setMoving(true)}
      onAnimationComplete={() => setMoving(false)}
    >
      <div ref={inner}>{children}</div>
    </m.div>
  );
}
