import type { Metadata } from "next";
import OperationsPage from "@/src/modules/operations/OperationsPage";

export const metadata: Metadata = { title: "Operations" };

export default function Page() {
  return <OperationsPage />;
}
