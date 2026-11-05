"use client";
import "./globals.css";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/src/components/ui/Button";
import { Fallback } from "@/src/components/ui/Fallback";

/** The root layout itself failed: this replaces the document, in the panel's own tokens. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en" className="antialiased">
      <body className="min-h-dvh bg-canvas px-4 text-fg">
        <title>Something went wrong - Tredio admin</title>
        <Fallback
          icon={<TriangleAlert size={20} aria-hidden />}
          title="The admin panel could not load"
          footer={error.digest ? <span className="font-mono">Reference {error.digest}</span> : null}
          actions={
            <>
              <Button variant="primary" icon={<RotateCcw size={16} aria-hidden />} onClick={() => retry()}>
                Try again
              </Button>
              <Button onClick={() => window.location.reload()}>Reload the page</Button>
            </>
          }
        >
          An unexpected error stopped the panel. Nothing was changed on the backend.
        </Fallback>
      </body>
    </html>
  );
}
