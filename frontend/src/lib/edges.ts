"use client";
import { useEffect, useState } from "react";

/** Which ends of a sideways scroller have more content past them (a pixel of slack for rounding). */
export function scrollEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): { start: boolean; end: boolean } {
  return { start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 };
}

/**
 * Props for a sideways scroller (spread them on it): a ref, and `data-fade-start` and
 * `data-fade-end` kept in step with its scroll, so the `.edge-fade` mask fades only the ends that
 * hide more cards.
 */
export function useEdgeFade() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const next = scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
      setEdges((e) => (e.start === next.start && e.end === next.end ? e : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [el]);
  return { ref: setEl, "data-fade-start": edges.start || undefined, "data-fade-end": edges.end || undefined };
}
