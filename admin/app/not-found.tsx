import { Compass } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/src/components/ui/Button";
import { Fallback } from "@/src/components/ui/Fallback";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <Fallback
      icon={<Compass size={20} aria-hidden />}
      title="This page does not exist"
      actions={
        <>
          <Link href="/candidates" className={buttonClass("primary")}>
            Candidates
          </Link>
          <Link href="/operations" className={buttonClass("secondary")}>
            Operations
          </Link>
        </>
      }
    >
      The address may be mistyped, or the page moved. The admin panel has two screens.
    </Fallback>
  );
}
