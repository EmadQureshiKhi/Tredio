/**
 * Brings `el` fully into view inside the panel that scrolls it (a bounded ticket, a sheet),
 * never scrolling the page itself. Smooth unless the system asks for reduced motion.
 */
export function revealInPanel(el: HTMLElement | null): void {
  if (!el) return;
  let panel = el.parentElement;
  while (panel && panel !== document.body) {
    const { overflowY } = getComputedStyle(panel);
    if ((overflowY === "auto" || overflowY === "scroll") && panel.scrollHeight > panel.clientHeight) break;
    panel = panel.parentElement;
  }
  if (!panel || panel === document.body) return;
  const box = panel.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  // Bottom into view, unless that would push its top out (then its top, 8px in).
  const by = r.bottom > box.bottom ? Math.min(r.bottom - box.bottom + 8, r.top - box.top - 8) : r.top < box.top ? r.top - box.top - 8 : 0;
  if (by === 0) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.scrollBy({ top: by, behavior: smooth ? "smooth" : "auto" });
}

/** One soft ring around `el`, to point at a value that just changed (no movement). */
export function pulse(el: HTMLElement | null): void {
  if (!el) return;
  const ring = getComputedStyle(document.documentElement).getPropertyValue("--primary-soft").trim();
  el.animate([{ boxShadow: `0 0 0 0 ${ring}` }, { boxShadow: `0 0 0 4px ${ring}`, offset: 0.35 }, { boxShadow: "0 0 0 0 transparent" }], { duration: 900, easing: "ease-out" });
}
