"use client";
import type { EvmSignature } from "@tredio/contracts";
import { Bot, Users } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import { Badge, Button, ErrorNote, listItem, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { price, usdc } from "@/lib/format";
import { useSheets } from "@/lib/sheets";
import { closePosition } from "@/lib/trade/hyperliquid";
import { useTx } from "@/lib/trade/useTx";
import { type AssetPerpPosition, useRefreshPortfolio } from "./hooks";
import { Figure, SectionCard, SignedUsdc, toneOf } from "./parts";

/** Whether Autopilot or a copy opened a position, for its badge. */
export type AssetPerpTag = "autopilot" | "copy" | null;

/**
 * Hyperliquid positions of the account's own address (its NEAR Chain Signatures key), with the
 * balance there. Closing is a session order the account contract signs; withdrawing the balance is
 * a transfer the passkey approves (the Hyperliquid withdraw sheet).
 */
export function AssetPerpSection({ positions, free, labels, total }: { positions: AssetPerpPosition[]; free: number; labels: Map<number, AssetPerpTag>; total: number }) {
  const open = useSheets((s) => s.open);
  if (positions.length === 0 && free < 0.005) return null;
  return (
    <SectionCard id="asset-perps-title" testId="asset-perp-section" title="Hyperliquid perps" count={positions.length} subtitle="Perps on the assets behind trends, from your account's own Hyperliquid address." total={usdc(total)} totalLabel="Value">
      {free >= 0.005 ? (
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-6">
          <p className="text-[13px] text-text-2">
            Free on Hyperliquid <span className="num font-strong text-text">{usdc(free)} USDC</span>
          </p>
          {free >= 0.01 ? (
            <Button tone="secondary" size="sm" className="shrink-0" onClick={() => open("hl-withdraw")} data-testid="asset-perp-withdraw">
              Withdraw
            </Button>
          ) : null}
        </div>
      ) : null}
      {positions.length > 0 ? (
        <ul className="relative divide-y divide-line border-t border-line">
          <AnimatePresence initial={false} mode="popLayout">
            {positions.map((p) => (
              <m.li key={`${p.market.symbol}-${p.side}`} {...listItem}>
                <Row p={p} tag={labels.get(p.market.id) ?? null} />
              </m.li>
            ))}
          </AnimatePresence>
        </ul>
      ) : null}
    </SectionCard>
  );
}

function Row({ p, tag }: { p: AssetPerpPosition; tag: AssetPerpTag }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const tx = useTx();
  const [refused, setRefused] = useState<string | null>(null);
  const close = async () => {
    setRefused(null);
    let reason: string | null = null;
    const r = await tx.run(
      async () => {
        const c = await closePosition(account.trade<EvmSignature>, { asset: p.market.symbol, assetIndex: p.market.id, szDecimals: p.market.szDecimals, size: p.size, long: p.side === "long", reference: p.market.midPx ?? p.market.markPx });
        reason = c.refused;
        return c.sent;
      },
      { action: `Close ${p.market.symbol}`, done: `${p.market.symbol} close signed and sent`, pending: "Signing with NEAR Chain Signatures" },
    );
    if (r) {
      setRefused(reason);
      refresh();
    }
  };
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:px-6" data-testid="asset-perp-row">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-strong text-[15px] text-text">{p.market.symbol}</span>
          <Badge tone={p.side === "long" ? "up" : "down"}>
            {p.side === "long" ? "Long" : "Short"} {p.leverage}x
          </Badge>
          {tag === "autopilot" ? (
            <Badge tone="primary" icon={<Bot className="size-3" aria-hidden />}>
              Autopilot
            </Badge>
          ) : tag === "copy" ? (
            <Badge tone="primary" icon={<Users className="size-3" aria-hidden />}>
              Copy
            </Badge>
          ) : null}
        </div>
        <p className={`num shrink-0 font-strong text-[15px] ${toneOf(p.pnl)}`}>
          <SignedUsdc value={p.pnl} /> USDC
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Size">{p.size}</Figure>
        <Figure label="Entry">{price(p.entryPrice)}</Figure>
        <Figure label="Mark">{price(p.market.markPx)}</Figure>
        <Figure label="Liquidation">{price(p.liquidationPx)}</Figure>
      </div>
      <Button tone="danger" size="sm" className="self-start" loading={tx.busy} onClick={() => void close()} data-testid="asset-perp-close">
        Close
      </Button>
      {refused ? <ErrorNote message={`Hyperliquid did not close it: ${refused}`} /> : null}
      <TxStatus tx={tx} filledLabel="Signed" testId="asset-perp-close-tx" />
    </div>
  );
}
