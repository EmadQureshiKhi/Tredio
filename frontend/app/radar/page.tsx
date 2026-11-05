import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import RadarPage from "@/features/radar/RadarPage";

export const metadata: Metadata = { title: "On the radar", description: "Topics waiting for a live market, with the attention measured so far. Each lists the moment a slot opens." };

export default function Page() {
  return (
    <PageTransition>
      <RadarPage />
    </PageTransition>
  );
}
