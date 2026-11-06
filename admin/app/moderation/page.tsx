import type { Metadata } from "next";
import { Suspense } from "react";
import ModerationPage from "@/src/modules/moderation/ModerationPage";

export const metadata: Metadata = { title: "Moderation" };

export default function Page() {
  // The page reads its tab from the query string, which is only known in the browser.
  return (
    <Suspense>
      <ModerationPage />
    </Suspense>
  );
}
