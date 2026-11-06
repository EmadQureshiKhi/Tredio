"use client";
import Link from "next/link";
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import { listItem } from "@/components/ui";
import { ShareMenu } from "@/features/share/ShareActions";
import { type PerpClose } from "@/features/share/data";
import { pnlSharePath } from "@/features/share/share";
import { PositionRow } from "@/features/trend/PerpTicket";
import { useAccount } from "@/lib/account/AccountProvider";
import { points, usdc } from "@/lib/format";
import { baseIdentifier, trendName } from "@/lib/trends";
import type { PerpHolding } from "./hooks";
import { toUsdc } from "./math";
import { SectionCard, signedUsdc, toneOf } from "./parts";

/**
 * Attention perps, one block per position: live PnL at the market's mark (funding included), its
 * liquidation index, and close or add margin. A close leaves a verified share link behind.
 */
export function PerpSection({ positions, total }: { positions: PerpHolding[]; total: number }) {
  const account = useAccount();
  const [closed, setClosed] = useState<Array<{ close: PerpClose; hash: string; name: string }>>([]);
  if (positions.length === 0 && closed.length === 0) return null;
  return (
    <SectionCard id="perps-title" testId="perp-section" title="Attention perps" count={positions.length} subtitle="Long or short a trend's attention index, isolated margin up to 3x." total={usdc(total)} totalLabel="Equity">
      <ul className="relative flex flex-col gap-3 border-t border-line px-4 py-4 sm:px-6">
        <AnimatePresence initial={false} mode="popLayout">
          {positions.map((p) => {
            const name = p.trendInfo ? trendName(p.trendInfo) : baseIdentifier(p.trend);
            const pnl = toUsdc(p.equity - p.margin);
            return (
              <m.li key={p.id} {...listItem} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Link href={`/t/${p.trend}`} className="truncate font-strong text-[14.5px] text-text underline-offset-4 hover:underline">
                    {name}
                  </Link>
                  <ShareMenu
                    text={`${p.isLong ? "Long" : "Short"} ${name} attention on Tredio: ${signedUsdc(pnl)} USDC so far.`}
                    path={pnlSharePath({ kind: "attention", market: name, side: p.isLong ? "long" : "short", pnl, roi: p.margin > 0n ? (pnl / toUsdc(p.margin)) * 100 : null, entry: p.entryIndex, exit: p.index, leverage: p.margin > 0n ? Math.round((toUsdc(p.notional) / toUsdc(p.margin)) * 10) / 10 : null, tx: null, account: null, identifier: p.trend })}
                  />
                </div>
                <PositionRow p={p} index={p.index} retired={p.trendInfo?.status === "retired"} onClosed={(close, hash) => setClosed((c) => [{ close, hash, name }, ...c].slice(0, 3))} />
              </m.li>
            );
          })}
        </AnimatePresence>
        {closed.map(({ close, hash, name }) => {
          const pnl = close.payout - close.margin - close.entryNotional * 0.001;
          return (
            <li key={hash} className="flex items-center justify-between gap-3 rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px]" data-testid="perp-closed">
              <span className="min-w-0 truncate text-text-2">
                Closed {close.isLong ? "long" : "short"} on <span className="font-strong text-text">{name}</span> at <span className="num">{points(close.exitIndex)}</span>: <span className={`num font-strong ${toneOf(pnl)}`}>{signedUsdc(pnl)} USDC</span>
              </span>
              <ShareMenu
                text={`Closed ${close.isLong ? "long" : "short"} ${name} attention on Tredio for ${signedUsdc(pnl)} USDC.`}
                path={pnlSharePath({ kind: "attention", market: name, side: close.isLong ? "long" : "short", pnl, roi: close.margin > 0 ? (pnl / close.margin) * 100 : null, entry: close.entryIndex, exit: close.exitIndex, leverage: close.margin > 0 ? Math.round((close.entryNotional / close.margin) * 10) / 10 : null, tx: hash, account: account.address ?? null, identifier: close.trend })}
              />
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
