"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AlertTriangle, CircleCheck, Info, Loader2 } from "lucide-react";
import { useState } from "react";
import { Toaster } from "sonner";
import { useMedia } from "@/components/ui/useMedia";
import AccountProvider from "@/lib/account/AccountProvider";
import { MotionProvider } from "@/lib/motion/MotionProvider";
import { ThemeProvider } from "@/lib/theme";

/** Toasts in the app's own tokens, so they follow light and dark like every other surface. */
const TOAST_CLASSES = {
  toast: "relative flex w-full items-start gap-3 overflow-hidden rounded-[14px] border border-line bg-surface py-3.5 pl-4 pr-11 font-sans text-text shadow-pop",
  icon: "relative mt-0.5 flex size-4 shrink-0 items-center justify-center",
  content: "flex min-w-0 flex-1 flex-col gap-0.5",
  title: "font-strong text-[13.5px] leading-5 text-text",
  description: "text-[12.5px] leading-[18px] text-text-2",
  actionButton: "ml-auto h-7 shrink-0 self-center rounded-lg border border-line bg-surface-2 px-2.5 font-strong text-[12px] text-text-2 transition-colors hover:border-line-strong hover:text-text",
  closeButton:
    "absolute right-2.5 top-2.5 flex size-6 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-primary [&>svg]:size-3.5",
};

/** Below lg the bottom nav (64px over the home indicator) holds the screen's foot, so toasts rise above it. */
const ABOVE_NAV = "calc(env(safe-area-inset-bottom) + 76px)";

/**
 * Toasts sit at the bottom: right on desktop, centered over the bottom nav on phones and tablets,
 * clear of the header and the search list, and of the page's main actions at the top.
 */
export default function AppProviders({ children }: { children: React.ReactNode }) {
  const wide = useMedia("(min-width: 1024px)");
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } } }));
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MotionProvider>
          <AccountProvider>{children}</AccountProvider>
        </MotionProvider>
        <Toaster
          position={wide ? "bottom-right" : "bottom-center"}
          offset={wide ? { bottom: 24, right: 24 } : { bottom: ABOVE_NAV }}
          mobileOffset={{ bottom: ABOVE_NAV, left: 12, right: 12 }}
          duration={4_000}
          gap={10}
          visibleToasts={4}
          containerAriaLabel="Notifications"
          closeButton
          icons={{
            success: <CircleCheck className="size-4 text-up" aria-hidden />,
            error: <AlertTriangle className="size-4 text-down" aria-hidden />,
            warning: <AlertTriangle className="size-4 text-warn" aria-hidden />,
            info: <Info className="size-4 text-primary" aria-hidden />,
            loading: <Loader2 className="size-4 animate-spin text-text-2" aria-hidden />,
          }}
          toastOptions={{ unstyled: true, classNames: TOAST_CLASSES }}
        />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
