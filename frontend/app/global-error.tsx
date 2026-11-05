"use client";
import "./globals.css";
import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Wordmark } from "@/components/shell/Logo";
import { Button, Fallback } from "@/components/ui";
import { THEME_KEY } from "@/lib/theme";
import { fontVariables } from "./fonts";

/**
 * The root layout itself failed, so this replaces the whole document: the app's fonts, tokens and
 * chosen theme, the wordmark, and a retry.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    } catch {
      // Storage blocked: the system theme applies.
    }
  }, [error]);
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <title>Something went wrong | Tredio</title>
        <main className="mx-auto flex min-h-dvh w-full max-w-[1240px] flex-col px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center text-text">
            <Wordmark className="h-[18px] w-auto" />
          </div>
          <Fallback
            className="flex-1"
            eyebrow="Something went wrong"
            title="Tredio could not load"
            body="An unexpected error stopped the app. Your funds and positions are safe. Try again in a moment."
            actions={
              <>
                <Button icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => retry()}>
                  Try again
                </Button>
                {/* A full page load, for when the client router went down with the layout. */}
                <Button tone="secondary" onClick={() => window.location.reload()}>
                  Reload the page
                </Button>
              </>
            }
            footer={error.digest ? <span className="font-mono">Reference {error.digest}</span> : null}
          />
        </main>
      </body>
    </html>
  );
}
