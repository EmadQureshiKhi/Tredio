import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import Status from "@/features/status/Status";

export const metadata: Metadata = {
  title: "Status",
  description: "Live health of Tredio: the attention oracle, the keeper, the market maker, the relayer and Autopilot.",
};

export default function Page() {
  return (
    <PageTransition>
      <Status />
    </PageTransition>
  );
}
