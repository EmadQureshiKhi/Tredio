import type { Metadata } from "next";
import WaitlistPage from "@/src/modules/waitlist/WaitlistPage";

export const metadata: Metadata = { title: "Waitlist" };

export default function Page() {
  return <WaitlistPage />;
}
