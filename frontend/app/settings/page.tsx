import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import SettingsPage from "@/features/settings/SettingsPage";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <PageTransition>
      <SettingsPage />
    </PageTransition>
  );
}
