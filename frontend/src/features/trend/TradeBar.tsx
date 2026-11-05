"use client";
import { useEffect, useMemo, useState } from "react";
import { Button, cn, Num, Sheet } from "@/components/ui";
import type { Trend } from "@/lib/api";
import { trendName } from "@/lib/trends";
import { useBook, useSeries } from "./data";
import OutcomeTicket, { best, CENTS, orderSeries, type Side } from "./OutcomeTicket";
import { useNow } from "./ticket";

/**
 * Phones and tablets: Up and Down at their live prices, held above the bottom nav, opening the
 * ticket in a sheet. It steps aside while the page's own ticket is on screen, and the page keeps
 * room for it at the end so it never covers the last content.
 */
export default function TradeBar({ trend }: { trend: Trend }) {
  const series = useSeries(trend.id);
  const now = useNow(5_000);
  const s = useMemo(() => orderSeries(series.data ?? []).find((x) => x.outcome === 0 && x.expiry > now / 1000), [series.data, now]);
  const upBook = useBook(s?.listed ? s.upMarket : undefined);
  const downBook = useBook(s?.listed ? s.downMarket : undefined);
  const [side, setSide] = useState<Side | null>(null);
  // Kept while the sheet animates out.
  const [last, setLast] = useState<Side>("up");
  const ticketInView = useTicketInView();
  if (!s) return null;
  const up = best(upBook.data, "ask");
  const down = best(downBook.data, "ask");
  const shown = !ticketInView;
  const open = (x: Side) => {
    setLast(x);
    setSide(x);
  };
  return (
    <>
      <div aria-hidden className="h-[60px] lg:hidden" />
      <div
        data-trade-bar={shown ? "shown" : "hidden"}
        className={cn(
          "fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+64px)] z-30 border-t border-line bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-4 py-2.5 backdrop-blur-xl transition-[translate,opacity] duration-200 ease-out lg:hidden",
          shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
        )}
        inert={!shown}
      >
        <div className="mx-auto grid max-w-md grid-cols-2 gap-2">
          <Button tone="up" onClick={() => open("up")} data-testid="bar-buy-up">
            Buy Up
            <Num value={up === null ? null : up * 100} {...CENTS} className="num" />
          </Button>
          <Button tone="down" onClick={() => open("down")} data-testid="bar-buy-down">
            Buy Down
            <Num value={down === null ? null : down * 100} {...CENTS} className="num" />
          </Button>
        </div>
      </div>
      <Sheet open={side !== null} onOpenChange={(o) => !o && setSide(null)} title={`Up or down on ${trendName(trend)}`} description="Pays 1 USDC a token if you are right." testId="trade-sheet">
        <OutcomeTicket key={last} trend={trend} initialSide={side ?? last} />
      </Sheet>
    </>
  );
}

/** True while the page's own trade panel is at least partly on screen. */
function useTicketInView(): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = document.querySelector("[data-trade-anchor]");
    if (!el) return;
    const observer = new IntersectionObserver(([e]) => setInView(e!.isIntersecting), { rootMargin: "0px 0px -120px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return inView;
}
