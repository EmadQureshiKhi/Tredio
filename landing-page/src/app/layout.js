import "./globals.css";
import { Hanken_Grotesk, Newsreader } from "next/font/google";
import LenisSmoothScroll from "@/components/Lenis/LenisScroll";
import PageTransition from "@/components/page-transition/PageTransition";
import { WaitlistProvider } from "@/components/waitlist/Waitlist";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/config/links";

// Open fonts (SIL OFL 1.1): Hanken Grotesk for text and UI (variable, light to bold) and Newsreader
// for display lines (variable, with its optical sizes). "Third" is Hanken Grotesk at medium weight,
// set in globals.css.
const sans = Hanken_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-body",
  display: "swap",
});

const serif = Newsreader({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  variable: "--font-display",
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
};

export const viewport = {
  themeColor: "#09090B",
  colorScheme: "dark",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body className="antialiased">
        <LenisSmoothScroll />
        <WaitlistProvider>
          <PageTransition>{children}</PageTransition>
        </WaitlistProvider>
      </body>
    </html>
  );
}
