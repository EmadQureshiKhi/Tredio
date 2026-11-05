import "./globals.css";
import localFont from "next/font/local";
import LenisSmoothScroll from "@/components/Lenis/LenisScroll";
import PageTransition from "@/components/page-transition/PageTransition";
import { WaitlistProvider } from "@/components/waitlist/Waitlist";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/config/links";

const Font1 = localFont({
  src: [{ path: "./fonts/font1.woff2", weight: "300", style: "normal" }],
  variable: "--font-body",
  display: "swap",
});

const Font2 = localFont({
  src: [{ path: "./fonts/font2.woff2", weight: "400", style: "normal" }],
  variable: "--font-display",
  display: "swap",
});

const Font3 = localFont({
  src: [{ path: "./fonts/font3.woff2", weight: "400", style: "normal" }],
  variable: "--font-third",
  display: "swap",
});

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  icons: {
    icon: "/assets/icons/tredio-favicon.svg",
  },
};

export const viewport = {
  themeColor: "#09090B",
  colorScheme: "dark",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${Font1.variable} ${Font2.variable} ${Font3.variable} antialiased`}>
        <LenisSmoothScroll />
        <WaitlistProvider>
          <PageTransition>{children}</PageTransition>
        </WaitlistProvider>
      </body>
    </html>
  );
}
