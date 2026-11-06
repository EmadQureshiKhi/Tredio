"use client";
import { Sparkles } from "lucide-react";
import { Button, TxStatus } from "@/components/ui";
import { confirmNote } from "@/features/trend/ticket";
import { useAccount } from "@/lib/account/AccountProvider";
import type { Trend } from "@/lib/api";
import { usdc } from "@/lib/format";
import { useSheets } from "@/lib/sheets";
import { session } from "@/lib/trade/calls";
import { useTx } from "@/lib/trade/useTx";
import { useRefreshPortfolio } from "./hooks";
import { toUsdc } from "./math";
import { SectionCard } from "./parts";

/** Curation rewards: the fee share for trends this account surfaced first, claimable at any time. */
export function CurationCard({ claimable, earned, trends }: { claimable: bigint; earned: bigint; trends: readonly Trend[] }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const open = useSheets((s) => s.open);
  const tx = useTx();
  const surfaced = trends.filter((t) => t.surfacer === account.address).length;
  if (earned === 0n && surfaced === 0) return null;
  const claim = async () => {
    if (await tx.run(() => account.trade(session.claimCuration), { action: "Claim curation rewards", done: `Claimed ${usdc(toUsdc(claimable))} USDC`, pending: confirmNote(account.kind, false) })) refresh();
  };
  return (
    <SectionCard id="curation-title" testId="curation-card" title="Curation rewards" subtitle={`You surfaced ${surfaced} ${surfaced === 1 ? "trend" : "trends"} first: 15% of their perp fees and 10% of their coin fees are yours. ${usdc(toUsdc(earned))} USDC earned so far.`} total={usdc(toUsdc(claimable))} totalLabel="To claim">
      <div className="flex flex-col gap-3 border-t border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="flex items-start gap-2 text-[13px] leading-5 text-text-2">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          Propose what everyone is talking about: when it lists, you earn from every trade on it.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button tone="ghost" size="sm" onClick={() => open("propose")}>
            Propose a trend
          </Button>
          <Button size="sm" disabled={claimable === 0n} loading={tx.busy} onClick={() => void claim()} data-testid="claim-curation">
            {claimable > 0n ? `Claim ${usdc(toUsdc(claimable))}` : "Nothing to claim"}
          </Button>
        </div>
      </div>
      <TxStatus tx={tx} filledLabel="Claimed" testId="curation-tx" className="mx-4 mb-4 sm:mx-6" />
    </SectionCard>
  );
}
