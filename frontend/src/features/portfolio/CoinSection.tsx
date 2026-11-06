"use client";
import Link from "next/link";
import { Badge, ButtonLink } from "@/components/ui";
import { useCoinSymbol } from "@/features/trend/CoinTicket";
import { COIN_DECIMALS } from "@/lib/config";
import { usdc } from "@/lib/format";
import { baseIdentifier, trendName } from "@/lib/trends";
import type { CoinHolding } from "./hooks";
import { coinPrice, Figure, SectionCard, tokens } from "./parts";

/** Trend coins held, valued at the curve's spot price; trading them is a passkey action on the trend's page. */
export function CoinSection({ coins, total }: { coins: CoinHolding[]; total: number }) {
  if (coins.length === 0) return null;
  return (
    <SectionCard id="coins-title" testId="coin-section" title="Trend coins" count={coins.length} subtitle="Each trend's coin on its bonding curve, or in its Rhea pool once it graduated." total={usdc(total)}>
      <ul className="divide-y divide-line border-t border-line">
        {coins.map((c) => (
          <CoinRow key={c.coin} c={c} />
        ))}
      </ul>
    </SectionCard>
  );
}

function CoinRow({ c }: { c: CoinHolding }) {
  const symbol = useCoinSymbol(c.coin);
  const name = c.trendInfo ? trendName(c.trendInfo) : baseIdentifier(c.trend);
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6" data-testid="coin-row">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link href={`/t/${c.trend}`} className="truncate font-strong text-[15px] text-text underline-offset-4 hover:underline">
            {symbol.data ? `$${symbol.data}` : name}
          </Link>
          {c.stage === "graduated" || c.stage === "pooled" ? <Badge tone="primary">On Rhea</Badge> : c.stage === "ready" ? <Badge tone="warn">Graduating</Badge> : null}
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-text-3">{name}</p>
      </div>
      <div className="grid grid-cols-3 gap-4 sm:flex sm:items-center sm:gap-6">
        <Figure label="Coins">{tokens(c.balance, COIN_DECIMALS)}</Figure>
        <Figure label="Price">{coinPrice(c.spot > 0 ? c.spot : null)}</Figure>
        <Figure label="Value">{c.value === null ? "-" : usdc(c.value)}</Figure>
        <ButtonLink href={`/t/${c.trend}`} tone="secondary" size="sm" className="col-span-3 sm:col-span-1">
          Trade
        </ButtonLink>
      </div>
    </li>
  );
}
