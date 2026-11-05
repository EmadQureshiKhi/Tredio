"use client";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button, ButtonLink, Fallback } from "@/components/ui";

/**
 * A screen that crashed while rendering: the shell stays, this screen offers a retry. Retrying
 * drops cached answers first, so a bad one is fetched again rather than rendered again.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const queries = useQueryClient();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Fallback
      eyebrow="Something went wrong"
      title="This screen could not load"
      body="Tredio hit an unexpected error showing it. Your funds and positions are safe. Try again, or head back to the markets."
      actions={
        <>
          <Button
            icon={<RotateCcw className="size-4" aria-hidden />}
            onClick={() => {
              void queries.resetQueries();
              retry();
            }}
          >
            Try again
          </Button>
          <ButtonLink href="/" tone="secondary">
            Back to markets
          </ButtonLink>
        </>
      }
      footer={error.digest ? <span className="font-mono">Reference {error.digest}</span> : null}
    />
  );
}
