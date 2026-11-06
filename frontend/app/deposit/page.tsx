import type { Metadata } from "next";
import { PageTransition } from "@/components/shell/PageTransition";
import DepositPage from "@/features/deposit/DepositPage";

export const metadata: Metadata = {
  title: "Move funds across chains",
  description: "Deposit from any chain into your Tredio account on NEAR, or withdraw anywhere, through NEAR Intents.",
};

export default function Page() {
  return (
    <PageTransition>
      <DepositPage />
    </PageTransition>
  );
}
