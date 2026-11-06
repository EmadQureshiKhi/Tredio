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
  "Attention markets on NEAR. An AI radar finds trends, an oracle built for a TEE scores each one from 0 to 100 on chain, and you trade the index from a passkey account: Up/Down outcomes, attention perps, trend coins and Hyperliquid perps.";

// The one address for every question (support, partners, press, security).
export const CONTACT_EMAIL = "contact@tredio.bid";

// Footer legal pages, shared by the desktop and mobile footers.
export const LEGAL_LINKS = [
  { title: "Cookie policy", href: "/cookies" },
  { title: "Legal notice & terms of use", href: "/terms" },
  { title: "Privacy policy", href: "/privacy" },
  { title: "Contact", href: "/contact" },
];

// Site menu, shared by the navbar and both footers. `scrollTo` targets a home page section;
// on any other page the item opens the home page at that section instead.
export const NAV_ITEMS = [
  { title: "Home", scrollTo: "#hero" },
  { title: "How it works", scrollTo: "#about" },
  { title: "Tracks", scrollTo: "#tracks" },
  { title: "Markets", scrollTo: "#examples" },
  { title: "Built with", scrollTo: "#stack" },
  { title: "Waitlist", scrollTo: "#waitlist" },
  { title: "Launch App", href: APP_URL, newTab: true },
];
