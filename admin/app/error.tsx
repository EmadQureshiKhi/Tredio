"use client";
import { RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonClass } from "@/src/components/ui/Button";
import { Fallback } from "@/src/components/ui/Fallback";

/** A screen that crashed while rendering: the header stays, this screen offers a retry. */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Fallback
      icon={<TriangleAlert size={20} aria-hidden />}
      title="This screen could not load"
      footer={error.digest ? <span className="font-mono">Reference {error.digest}</span> : null}
      actions={
        <>
          <Button variant="primary" icon={<RotateCcw size={16} aria-hidden />} onClick={() => retry()}>
            Try again
          </Button>
          <Link href="/candidates" className={buttonClass("secondary")}>
            Candidates
          </Link>
        </>
      }
    >
      The panel hit an unexpected error showing it. Nothing was changed on the backend.
    </Fallback>
  );
}
