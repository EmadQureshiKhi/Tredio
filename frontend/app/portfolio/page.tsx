import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import Portfolio from "@/features/portfolio/Portfolio";

export const metadata: Metadata = {
  title: "Portfolio",
  description: "Your UP and DOWN tokens, attention perps, asset perps, trend coins and curation earnings, valued live.",
};

export default function Page() {
  return (
    <PageTransition>
      <Portfolio />
    </PageTransition>
  );
}
