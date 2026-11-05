import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import TrendView from "@/features/trend/TrendView";
import { BACKEND_URL } from "@/lib/config";

const normalize = (identifier: string) => decodeURIComponent(identifier).toLowerCase();

async function summary(identifier: string): Promise<{ displayName: string | null; summary: string | null } | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/v1/trends/${encodeURIComponent(identifier)}`, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { trend: { displayName: string | null; summary: string | null } }).trend;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PageProps<"/t/[identifier]">): Promise<Metadata> {
  const identifier = normalize((await params).identifier);
  const t = await summary(identifier);
  const name = t?.displayName ?? identifier;
  return {
    title: `${name} attention`,
    description: t?.summary ?? `Trade the attention on ${name}: up or down, attention perps and more.`,
  };
}

export default async function Page({ params }: PageProps<"/t/[identifier]">) {
  const identifier = normalize((await params).identifier);
  // Keyed, so moving from one trend to another (a relisting) crossfades like any other page.
  return (
    <PageTransition key={identifier}>
      <TrendView identifier={identifier} />
    </PageTransition>
  );
}
