// Tiles on the Signal card: where the attention index comes from.
// Logo files live in public/assets/logos; their sources and the brand terms that cover them are
// listed in ASSETS.md. A tile with `cover` fills with that picture instead of a centred logo, and a
// tile with `marks` stacks several partners' marks (each with its own size, link or text badge).
// Wikimedia allows its logos only as a link to a Wikimedia site, hence `href` on the Wikipedia tile;
// CoinGecko's attribution guide asks for its logos to link to its sites, hence theirs.
export const SIGNAL_LOGOS = [
  {
    name: "Elfa and Bluesky",
    role: "Social mentions",
    background: "#FFFFFF",
    foreground: "#1B1530",
    // Bluesky asks for clear space around its logo equal to the butterfly's height.
    gap: "12%",
    marks: [
      { name: "Elfa", src: "/assets/logos/elfa.svg", width: "46%", height: "17%" },
      { name: "Bluesky", src: "/assets/logos/bluesky.svg", width: "40%", height: "9%" },
    ],
  },
  {
    name: "Wikipedia",
    role: "Pageviews",
    src: "/assets/logos/wikipedia-wordmark.svg",
    href: "https://www.wikipedia.org/",
    background: "#0F0F12",
    width: "62%",
  },
  {
    name: "Nansen",
    role: "Smart-money flows",
    src: "/assets/logos/nansen.svg",
    background: "#08140F",
    width: "50%",
  },
  {
    name: "Hacker News, CoinGecko and GeckoTerminal",
    role: "Trending lists",
    background: "#0D1217",
    gap: "7%",
    marks: [
      { name: "Hacker News", text: "Hacker News", href: "https://news.ycombinator.com/", color: "#000000", background: "#FF6600" },
      { name: "CoinGecko", src: "/assets/logos/coingecko.svg", href: "https://www.coingecko.com/", width: "44%", height: "10%" },
      { name: "GeckoTerminal", src: "/assets/logos/geckoterminal.svg", href: "https://www.geckoterminal.com/", width: "48%", height: "10%" },
    ],
  },
];
