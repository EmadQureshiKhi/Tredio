import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import PnlShareView from "@/features/share/PnlShare";
import { verifiedPerpShare } from "@/features/share/data";
import { parsePnlShare, pnlHeadline, pnlSharePath } from "@/features/share/share";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const amount = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v))} USDC`;

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const share = parsePnlShare(await searchParams);
  if (!share) return { title: "Trade attention" };
  const title = `${amount(share.pnl)} on ${pnlHeadline(share)}`;
  const image = `/share/pnl/image?${pnlSharePath(share).split("?")[1]}`;
  return {
    title,
    description: "A result on Tredio, the attention market: trade what the world pays attention to.",
    openGraph: { title, type: "article", images: [{ url: image, width: 1200, height: 630, alt: title }] },
  };
}

export default async function Page({ searchParams }: Props) {
  const share = parsePnlShare(await searchParams);
  // Verified results show only what the ledger and the indexer recorded, never the link's own claims.
  const checked = share ? await verifiedPerpShare(share) : null;
  return (
    <PageTransition>
      <PnlShareView share={checked?.share ?? share} verified={checked !== null} owner={checked?.owner ?? null} />
    </PageTransition>
  );
}
