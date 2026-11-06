"use client";
import { Card, CardHeader, ExplorerLink } from "@/components/ui";
import type { Trend } from "@/lib/api";
import { DEPLOYMENT, explorerAddress } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useCoinSymbol } from "./CoinTicket";
import { useAssetPerpMarket, useCurve, useSeries } from "./data";

/**
 * Where this trend lives on NEAR: the registry that records its index, the outcomes ledger and
 * book of its series, the perps, its coin, and the contracts behind them. Each links to NearBlocks.
 */

interface Item {
  label: string;
  note: string;
  account: string;
}

const c = DEPLOYMENT.contracts;

export default function OnChain({ trend }: { trend: Trend }) {
  const series = useSeries(trend.id);
  const curve = useCurve(trend.id);
  const coin = curve.data?.coin;
  const symbol = useCoinSymbol(coin);
  const { market } = useAssetPerpMarket(trend.asset ?? trend.ticker);
  const current = [...(series.data ?? [])].sort((a, b) => (a.window === 86_400 ? -1 : b.window === 86_400 ? 1 : a.window - b.window))[0];

  const items: Item[] = [
    { label: "Attention index", note: "Registry, written only by the oracle's signed reports", account: c.registry },
    { label: "Up and Down tokens", note: current ? `Series ${current.series}: tokens ${current.series}:up and ${current.series}:down, each pays 1 USDC if it wins` : "Every series' tokens, minted and settled here", account: c.outcomes },
    { label: "Order book", note: current?.listed ? `Up and Down of series ${current.series} against USDC` : "Up and Down against USDC, 0.001 USDC ticks", account: c.book },
    { label: "Attention perps", note: "Positions, margin and funding", account: c.perps },
    ...(coin ? [{ label: symbol.data ? `$${symbol.data}` : "Trend coin", note: "This trend's coin", account: coin }] : []),
    { label: "Trend coins", note: "Bonding curves and graduation into Rhea", account: c.coins },
    { label: "Curation", note: "Fees owed to whoever surfaced a trend", account: c.curation },
    ...(market ? [{ label: "Chain Signatures", note: `Signs ${market.symbol} orders on Hyperliquid for each account`, account: DEPLOYMENT.external.chainSignatures }] : []),
    { label: "USDC", note: DEPLOYMENT.network === "testnet" ? "Test USDC with a faucet; settles every market" : "Settles every market", account: c.usdc },
  ];

  return (
    <Card data-testid="trend-onchain">
      <CardHeader title="On NEAR" subtitle="Every contract and account, open on NearBlocks" />
      <ul className="mt-2 divide-y divide-line px-5 pb-2">
        {items.map((it) => (
          <li key={`${it.label}-${it.account}`} className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-strong text-[13.5px] text-text">{it.label}</p>
              <p className="truncate text-[12px] text-text-3">{it.note}</p>
            </div>
            <ExplorerLink href={explorerAddress(it.account)} className="num shrink-0 font-mono text-[12.5px] text-text-2" testId="onchain-link">
              {shortAddress(it.account)}
            </ExplorerLink>
          </li>
        ))}
      </ul>
    </Card>
  );
}
