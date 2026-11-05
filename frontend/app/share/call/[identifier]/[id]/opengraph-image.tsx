import { callImage } from "@/features/share/cards";
import { sharedCall } from "@/features/share/data";
import { OG_SIZE } from "@/features/share/og";

export const alt = "A call on Tredio: up or down on a trend's attention";
export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 300;

export default async function Image({ params }: { params: Promise<{ identifier: string; id: string }> }) {
  const { identifier, id } = await params;
  const callId = Number(id);
  return callImage(Number.isSafeInteger(callId) && callId > 0 ? await sharedCall(decodeURIComponent(identifier), callId) : null);
}
