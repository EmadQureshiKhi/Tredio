import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import LeadersPage from "@/features/leaders/LeadersPage";

export const metadata: Metadata = { title: "Leaders", description: "Callers ranked by how often their calls on attention come true, traders by realized PnL, and Autopilot by its record." };

export default async function Page(props: PageProps<"/leaders">) {
  const { tab } = await props.searchParams;
  return (
    <PageTransition>
      <LeadersPage initialTab={tab === "traders" || tab === "autopilot" ? tab : "callers"} />
    </PageTransition>
  );
}
