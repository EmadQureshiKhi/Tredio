import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageTransition } from "@/components/shell/PageTransition";
import CallShare from "@/features/share/CallShare";
import { callerName, sharedCall, trendName } from "@/features/share/data";

type Props = { params: Promise<{ identifier: string; id: string }> };

async function load(params: Props["params"]) {
  const { identifier, id } = await params;
  const callId = Number(id);
  if (!Number.isSafeInteger(callId) || callId <= 0) return null;
  return sharedCall(decodeURIComponent(identifier), callId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await load(params);
  if (!data) return { title: "Call not found" };
  const { call, trend } = data;
  const name = trend ? trendName(trend) : (call.identifier ?? "");
  const title = `${callerName(call)} called ${call.direction.toUpperCase()} on ${name}`;
  return {
    title,
    description: `${call.note ? `"${call.note.slice(0, 120)}" ` : ""}Called at ${Number(call.opening_index).toFixed(2)} on Tredio, the attention market.`,
    openGraph: { title, type: "article" },
  };
}

export default async function Page({ params }: Props) {
  const data = await load(params);
  if (!data) notFound();
  return (
    <PageTransition>
      <CallShare data={data} />
    </PageTransition>
  );
}
