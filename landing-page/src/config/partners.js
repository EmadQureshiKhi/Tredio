// The "Built with" section: what Tredio runs on and where its attention data comes from.
// Logo files live in public/assets/logos, each taken unmodified from the vendor's own brand kit or site;
// sources and terms are in ASSETS.md.
// `ratio` is the logo file's width / height, so every logo can be sized to the same optical area;
// `scale` corrects for padding and visual weight inside each file; `withName` sets a symbol-only mark beside the name.
export const STACK = [
  {
    name: "NEAR",
    role: "Accounts, markets and settlement",
    logo: { src: "/assets/logos/near.svg", ratio: 1440 / 351, scale: 0.84 },
    href: "https://near.org",
  },
  {
    name: "NEAR Intents",
    role: "Deposits from 38 chains",
    logo: { src: "/assets/logos/near-intents.svg", ratio: 1748.82 / 359.71, scale: 1.02 },
  },
  {
    name: "NEAR AI Cloud",
    role: "Verifiable AI review",
    logo: { src: "/assets/logos/near-ai.svg", ratio: 730 / 138, scale: 0.74, minWidth: 120 },
    href: "https://near.ai",
  },
  {
    name: "OutLayer",
    role: "TEE attention oracle",
    logo: { src: "/assets/logos/outlayer.png", ratio: 1257 / 214, scale: 0.9 },
    href: "https://outlayer.ai",
  },
  {
    name: "Hyperliquid",
    role: "Perps on the underlying asset",
    logo: { src: "/assets/logos/hyperliquid.svg", ratio: 856 / 200, scale: 1.04 },
    href: "https://hyperliquid.xyz",
  },
  {
    name: "Rhea Finance",
    role: "Where trend coins graduate",
    logo: { src: "/assets/logos/rhea.svg", ratio: 34 / 31, withName: true },
    href: "https://rhea.finance",
  },
];

// Attention data sources. CoinGecko's attribution guide asks for its logos to link to its sites with
// "Data powered by" beside them; Wikimedia allows its marks only as a link to a Wikimedia site.
export const DATA_SOURCES = [
  {
    name: "Elfa",
    role: "Social mentions",
    logo: { src: "/assets/logos/elfa.svg", ratio: 76 / 26, scale: 0.92 },
    href: "https://www.elfa.ai",
  },
  {
    name: "Nansen",
    role: "Smart-money data powered by Nansen",
    logo: { src: "/assets/logos/nansen.svg", ratio: 117.98 / 47.85, scale: 1.3 },
    href: "https://www.nansen.ai",
  },
  {
    name: "CoinGecko",
    role: "Data powered by CoinGecko",
    logo: { src: "/assets/logos/coingecko.svg", ratio: 1000 / 219, scale: 0.94 },
    href: "https://www.coingecko.com/",
  },
  {
    name: "GeckoTerminal",
    role: "On-chain data powered by GeckoTerminal",
    logo: { src: "/assets/logos/geckoterminal.svg", ratio: 1002 / 191, scale: 0.94 },
    href: "https://www.geckoterminal.com/",
  },
  {
    name: "Wikipedia",
    role: "Pageviews",
    logo: { src: "/assets/logos/wikipedia-wordmark.svg", ratio: 119 / 18, scale: 0.78 },
    href: "https://www.wikipedia.org/",
  },
  {
    name: "Bluesky",
    role: "Posts and trending topics",
    logo: { src: "/assets/logos/bluesky.svg", ratio: 1148 / 252, scale: 0.86 },
    href: "https://bsky.app",
  },
];
