import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppProviders from "@/app-providers";
import AppShell from "@/components/shell/AppShell";
import GlobalSheets from "@/features/global/GlobalSheets";
import { WAITLIST_HINT_SCRIPT } from "@/features/waitlist/hint";
import { ACCOUNT_HINT_SCRIPT } from "@/lib/account/hint";
import { APP_URL } from "@/lib/config";
import { THEME_SCRIPT } from "@/lib/theme";
import { fontVariables } from "./fonts";

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: "Tredio: trade attention", template: "%s | Tredio" },
  description: "Trade what the world pays attention to: outcome markets, attention perps and asset perps, from one passkey.",
  applicationName: "Tredio",
  icons: { icon: [{ url: "/tredio-favicon.svg", type: "image/svg+xml" }], apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Tredio", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
  // Naming the card keeps link previews large: a twitter field without one falls back to a small card.
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        {/* Applies a chosen theme before first paint, so the page never flashes the other one. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Marks a browser that holds an account, so the first paint shows the right shell. */}
        <script dangerouslySetInnerHTML={{ __html: ACCOUNT_HINT_SCRIPT }} />
        {/* Marks a browser that joined the waitlist or dismissed its Home row, for the same reason. */}
        <script dangerouslySetInnerHTML={{ __html: WAITLIST_HINT_SCRIPT }} />
      </head>
      <body>
        <AppProviders>
          <AppShell>{children}</AppShell>
          <GlobalSheets />
        </AppProviders>
      </body>
    </html>
  );
}
