import { BadgeCheck, TrendingUp } from "lucide-react";
import { Badge, ButtonLink, Card, cn, Delta, Empty, ExplorerLink } from "@/components/ui";
import { explorerTx } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { usdc } from "@/lib/format";
import { ShareActions } from "./ShareActions";
import { type PnlShare, pnlHeadline, pnlSharePath, trimZeros } from "./share";

const KIND_LABEL: Record<PnlShare["kind"], string> = { attention: "Attention perp", assetPerp: "Asset perp", outcome: "Outcome market", coin: "Trend coin" };

const level = (v: number) => (v >= 1000 ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v) : v >= 1 ? trimZeros(v, 3) : trimZeros(v, 4));

/** A shared trade result, with "Verified" only when the closing transaction agrees. */
export default function PnlShareView({ share, verified, owner = null }: { share: PnlShare | null; verified: boolean; owner?: string | null }) {
  if (!share) {
    return (
      <Empty
        title="This result link is incomplete"
        body="Its numbers are missing or malformed. Trade the attention economy on Tredio instead."
        icon={<TrendingUp className="size-6" />}
        action={<ButtonLink href="/">Explore markets</ButtonLink>}
        className="min-h-[60vh]"
      />
    );
  }
  const headline = pnlHeadline(share);
  const gain = share.pnl >= 0;
  const text = `${share.pnl > 0 ? "+" : share.pnl < 0 ? "-" : ""}${usdc(Math.abs(share.pnl))} USDC on ${headline} on Tredio`;
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 sm:pt-6">
      <p className="font-strong text-[12px] uppercase tracking-[0.14em] text-primary">{KIND_LABEL[share.kind]}</p>
      <Card className="overflow-hidden">
        <div className="relative flex flex-col gap-5 p-5 sm:p-7">
          <div aria-hidden className={cn("pointer-events-none absolute -right-20 -top-24 size-64 rounded-full blur-3xl", gain ? "bg-up-soft" : "bg-down-soft")} />
          <p className="relative text-[15px] text-text-2">{headline}</p>
          <div className="relative flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <p className={cn("num-display font-display text-[52px] leading-none sm:text-[64px]", share.pnl > 0 ? "text-up" : share.pnl < 0 ? "text-down" : "text-text")}>
              {share.pnl > 0 ? "+" : share.pnl < 0 ? "-" : ""}
              {usdc(Math.abs(share.pnl))}
            </p>
            <span className="text-[17px] text-text-3">USDC</span>
          </div>
          <dl className="relative grid grid-cols-3 gap-4 border-t border-line pt-5">
            <div>
              <dt className="text-[12px] uppercase tracking-[0.08em] text-text-3">Return</dt>
              <dd className="mt-1.5">{share.roi !== null ? <Delta value={share.roi} className="text-[20px]" /> : <span className="text-[20px] text-text-3">-</span>}</dd>
            </div>
            <div>
              <dt className="text-[12px] uppercase tracking-[0.08em] text-text-3">Entry</dt>
              <dd className="num mt-1.5 font-strong text-[20px] text-text">{share.entry !== null ? level(share.entry) : "-"}</dd>
            </div>
            <div>
              <dt className="text-[12px] uppercase tracking-[0.08em] text-text-3">Exit</dt>
              <dd className="num mt-1.5 font-strong text-[20px] text-text">{share.exit !== null ? level(share.exit) : "-"}</dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-2/50 px-5 py-3.5 text-[13px] sm:px-7">
          {verified ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone="up" icon={<BadgeCheck className="size-3.5" aria-hidden />}>
                Verified
              </Badge>
              {owner ? <span className="num font-mono text-[12px] text-text-3">by {shortAddress(owner)}</span> : null}
            </span>
          ) : (
            <span className="text-text-3">Shared by the trader; not verified.</span>
          )}
          {share.tx ? (
            <ExplorerLink href={explorerTx(share.tx)} className="text-text-2" />
          ) : null}
        </div>
      </Card>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ShareActions text={text} path={pnlSharePath(share)} className="[&>button]:flex-1 sm:[&>button]:flex-none" />
        <ButtonLink href={share.identifier ? `/t/${share.identifier}` : "/"} tone="secondary">
          {share.identifier ? "Trade this market" : "Trade on Tredio"}
        </ButtonLink>
      </div>
    </div>
  );
}
