import type { Metadata } from "next";
import { Suspense } from "react";
import CandidatesPage from "@/src/modules/candidates/CandidatesPage";

export const metadata: Metadata = { title: "Candidates" };

export default function Page() {
  // The page reads its tab from the query string, which is only known in the browser.
  return (
    <Suspense>
      <CandidatesPage />
    </Suspense>
  );
}
