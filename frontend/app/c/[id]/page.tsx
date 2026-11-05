import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import CallerProfile from "@/features/callers/CallerProfile";

const label = (id: string) => (/^[a-z0-9_]{3,20}$/.test(id) ? `@${id}` : `${id.slice(0, 6)}...${id.slice(-4)}`);

export async function generateMetadata(props: PageProps<"/c/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  return { title: label(decodeURIComponent(id)), description: "A Tredio caller's track record: calls on trends' attention, resolved by the oracle, and their Autopilot trading record." };
}

/** A caller by identity or handle, or a trading account's record. */
export default async function Page(props: PageProps<"/c/[id]">) {
  const { id } = await props.params;
  return (
    <PageTransition>
      <CallerProfile id={decodeURIComponent(id).toLowerCase()} />
    </PageTransition>
  );
}
