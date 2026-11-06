"use client";
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import { AnimateHeight, Card, cn, Segmented } from "@/components/ui";
import type { Trend } from "@/lib/api";
import AssetPerpTicket from "./AssetPerpTicket";
import CoinTicket from "./CoinTicket";
import { useAssetPerpMarket } from "./data";
import OutcomeTicket from "./OutcomeTicket";
import PerpTicket from "./PerpTicket";

type Tab = "outcome" | "perp" | "coin" | "assetPerp";

const BLURB: Record<Tab, string> = {
  outcome: "Up or down on attention by a deadline. Each token pays 1 USDC if you are right.",
  perp: "Long or short the index itself, up to 3x, open as long as you like.",
  coin: "This trend's coin on a bonding curve, graduating to its own pool.",
  assetPerp: "Hyperliquid perpetuals on the asset's own market price, signed by your account through NEAR Chain Signatures.",
};

/** Every way to trade a trend, one ticket at a time. */
export default function TradePanel({ trend, className }: { trend: Trend; className?: string }) {
  const { market } = useAssetPerpMarket(trend.asset ?? trend.ticker);
  const [tab, setTab] = useState<Tab>("outcome");
  const options = [
    { value: "outcome" as const, label: "Up/Down" },
    { value: "perp" as const, label: "Perp" },
    { value: "coin" as const, label: "Coin" },
    ...(market ? [{ value: "assetPerp" as const, label: market.symbol }] : []),
  ];
  const current = tab === "assetPerp" && !market ? "outcome" : tab;
  return (
    <Card className={cn("flex flex-col gap-4 p-4 sm:p-5", className)} data-testid="trade-panel">
      <div>
        <Segmented label="How to trade" value={current} onChange={setTab} options={options} />
        <p className="mt-2.5 text-[12.5px] leading-[18px] text-text-3">{BLURB[current]}</p>
      </div>
      {/* A panel taller than the window scrolls inside, under its fixed tabs, so its end stays reachable. */}
      <div className="-mx-4 -mb-4 -mt-1 min-h-0 overflow-y-auto overscroll-contain rounded-b-[var(--radius-card)] px-4 pb-4 pt-1 sm:-mx-5 sm:-mb-5 sm:px-5 sm:pb-5" data-testid="trade-panel-body">
        {/* Switching tickets: the old one fades out, the new one fades in as the panel eases to its height. */}
        <AnimateHeight>
          <AnimatePresence mode="wait" initial={false}>
            <m.div key={current} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.16, ease: "easeOut" } }} exit={{ opacity: 0, transition: { duration: 0.1, ease: "easeIn" } }}>
              {current === "outcome" ? <OutcomeTicket trend={trend} /> : current === "perp" ? <PerpTicket trend={trend} /> : current === "coin" ? <CoinTicket trend={trend} /> : <AssetPerpTicket trend={trend} />}
            </m.div>
          </AnimatePresence>
        </AnimateHeight>
      </div>
    </Card>
  );
}
