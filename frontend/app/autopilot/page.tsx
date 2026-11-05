import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import AutopilotPage from "@/features/autopilot/AutopilotPage";

export const metadata: Metadata = { title: "Autopilot", description: "Rules that trade asset perps when attention moves, backtested before they run and capped while they do." };

export default function Page() {
  return (
    <PageTransition>
      <AutopilotPage />
    </PageTransition>
  );
}
