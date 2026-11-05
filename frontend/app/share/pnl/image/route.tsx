import { pnlImage } from "@/features/share/cards";
import { verifiedPerpShare } from "@/features/share/data";
import { parsePnlShare } from "@/features/share/share";

/**
 * The PnL link card. The numbers come from the link's search params, which the file-based
 * opengraph-image convention cannot read, so /share/pnl points its og:image here.
 */
export async function GET(request: Request) {
  const share = parsePnlShare(new URL(request.url).searchParams);
  const checked = share ? await verifiedPerpShare(share) : null;
  const res = pnlImage(checked?.share ?? share, checked !== null);
  // The same link always draws the same card: cache it at the edge for a day.
  res.headers.set("cache-control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400");
  return res;
}
