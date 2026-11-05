import type { Metadata } from "next";
import RotationPage from "@/src/modules/rotation/RotationPage";

export const metadata: Metadata = { title: "Live board" };

export default function Page() {
  return <RotationPage />;
}
