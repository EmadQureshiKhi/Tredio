// Destination for every "Launch App" CTA on the landing page.
// Set NEXT_PUBLIC_APP_URL at build time to point at the deployed Tredio app
// (production: https://app.tredio.bid).
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// The Tredio backend the Mainnet waitlist form posts to (production: https://api.tredio.bid). Its
// LANDING_URL must list this site's origin.
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000").replace(/\/+$/, "");

// Public origin of this site, used for canonical URLs, Open Graph tags and the sitemap.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://tredio.bid";

export const SITE_NAME = "Tredio";
export const SITE_TITLE = "Tredio | Trade the World's Attention";
export const SITE_DESCRIPTION =
  "Tredio turns social attention into tradeable markets. An oracle records a 0 to 100 attention index for every trend, and passkey accounts trade it gas-free: Up/Down outcomes, attention perps and trend coins.";

// Footer legal pages, shared by the desktop and mobile footers.
export const LEGAL_LINKS = [
  { title: "Cookie policy", href: "/cookies" },
  { title: "Legal notice & terms of use", href: "/terms" },
  { title: "Privacy policy", href: "/privacy" },
];

// Site menu, shared by the navbar and both footers. `scrollTo` targets a home page section;
// on any other page the item opens the home page at that section instead.
export const NAV_ITEMS = [
  { title: "Home", scrollTo: "#hero" },
  { title: "About", scrollTo: "#about" },
  { title: "Markets", scrollTo: "#markets" },
  { title: "How It Works", scrollTo: "#insights" },
  { title: "Examples", scrollTo: "#casee-study" },
  { title: "Waitlist", scrollTo: "#waitlist" },
  { title: "Launch App", href: APP_URL, newTab: true },
];
