// Home page copy, shared by the desktop and phone layouts so both always say the same thing.
// Pictures in public/assets/img are Tredio's own renders unless ASSETS.md lists them.

// How it works: the slider after the hero (phones show it as its own slider).
export const HOW_IT_WORKS = [
  {
    image: "/assets/img/topics-islands.jpg",
    heading: "A topic starts trending. Tredio's radar spots it and proposes a market.",
    label: "Radar",
    detail: "Signals",
    description: "Six data sources feed it, around the clock.",
  },
  {
    image: "/assets/img/about-review.webp",
    heading: "A verifiable model on NEAR AI Cloud reviews the trend and signs its verdict.",
    label: "Review",
    detail: "NEAR AI Cloud",
    description: "The signed attestation is kept with the listing.",
  },
  {
    image: "/assets/img/crypto-chart.jpg",
    heading: "Inside an OutLayer TEE, an oracle scores its attention from 0 to 100 and writes it on NEAR.",
    label: "Oracle",
    detail: "OutLayer TEE",
    description: "The registry accepts attested reports only.",
  },
  {
    image: "/assets/img/about-markets.webp",
    heading: "Take a side on where the attention goes: Up or Down, a perp, or its coin.",
    label: "Markets",
    detail: "USDC",
    description: "Outcome series, perps up to 3x and trend coins.",
  },
  {
    image: "/assets/img/about-account.webp",
    heading: "Sign in with Face ID. One prompt opens a week of gas-free trading.",
    label: "Account",
    detail: "Passkey",
    description: "No seed phrase, no extension, no gas to pay.",
  },
];

// The four tracks Tredio fits, as cards.
export const TRACKS = [
  {
    id: "01",
    name: "Memecoins",
    background: "bg-[#6F61D1]",
    title: "A trend big enough to talk about gets a coin of its own.",
    description:
      "Every listed trend can launch a coin on a bonding curve. Its floor rises with the trend's peak attention, and when the curve fills, the coin graduates into a Rhea Finance pool.",
    image: "/assets/img/track-memecoins.webp",
    alt: "A trend coin card on its bonding curve, 72% of the way to graduation",
  },
  {
    id: "02",
    name: "Social Money",
    background: "bg-[#4C4496]",
    title: "Your calls build a record. Good records get followed.",
    description:
      "Post calls on trends and the leaderboard keeps score by hit rate. Followers copy your trades within their own limits, and whoever surfaced a trend first earns a share of its fees.",
    image: "/assets/img/track-social.webp",
    alt: "A call card with its hit rate beside a short leaderboard",
  },
  {
    id: "03",
    name: "DeFi",
    background: "bg-[#281F5E]",
    title: "Attention is the underlying. Everything else is a market.",
    description:
      "Up/Down series trade on Tredio's own order book and settle in USDC. Attention perps go up to 3x, and Hyperliquid perps on the asset behind a trend run from your NEAR account through Chain Signatures.",
    image: "/assets/img/track-defi.webp",
    alt: "An order book for an Up/Down series beside an attention perp ticket",
  },
  {
    id: "04",
    name: "Agent Economy",
    background: "bg-[#110F28]",
    title: "Agents read the index and trade by the rules you set.",
    description:
      "An MCP server and a pay-per-call x402 API give agents the index and the markets. Autopilot runs your rules on a policy wallet, inside limits your passkey signed.",
    image: "/assets/img/track-agents.webp",
    alt: "An agent's tool call reading a trend's index, and an Autopilot rule with its limits",
  },
];

// Example markets.
export const EXAMPLES = [
  {
    ticker: "NEAR",
    assetClass: "Crypto",
    marketType: "Up / Down",
    network: "NEAR testnet",
    quote:
      "NEAR is all over the feed. Will its attention index close the day above where it opened? Buy UP or DOWN: each winning token redeems for 1 USDC, each losing one for nothing.",
    image: "/assets/img/example-near.webp",
    alt: "A NEAR Up/Down market: UP at 0.62 USDC, DOWN at 0.38 USDC, attention index 71.4",
  },
  {
    ticker: "AI AGENTS",
    assetClass: "Narrative",
    marketType: "Attention perp",
    network: "NEAR testnet",
    quote:
      "A narrative has no ticker, but its attention does. Go long up to 3x while the story spreads, or short it as the feed moves on.",
    image: "/assets/img/example-agents.webp",
    alt: "An AI agents attention perp: a 3x long ticket beside the rising index",
  },
  {
    ticker: "HEATWAVE",
    assetClass: "Topic",
    marketType: "Trend coin",
    network: "NEAR testnet",
    quote:
      "A heatwave takes over the timeline. Back it early with its own coin on a bonding curve, and watch the floor rise with its peak attention.",
    image: "/assets/img/example-heatwave.webp",
    alt: "A heatwave trend coin on its bonding curve, with its rising floor",
  },
];

// The numbers section.
export const NUMBERS = [
  {
    number: "100",
    heading: "Attention, scored 0 to 100",
    content: "Six data sources become one index, computed in an OutLayer TEE and recorded on NEAR every minute.",
    image: "/assets/img/attention-cat.jpg",
    alt: "An illustrated lavender cat in a hoodie trading Up and Down at a desk in a library",
  },
  {
    number: "24",
    sup: "h",
    heading: "24-hour and 7-day rounds",
    content: "Every Up/Down series asks one question: will the index close above where it opened?",
    image: "/assets/img/stats-rounds.webp",
    alt: "Two round cards, 24 hours and 7 days, each counting down to its close",
  },
  {
    number: "1",
    heading: "Each winning token pays 1 USDC",
    content: "UP and DOWN trade between 0 and 1 USDC. At settlement the winning side pays 1 USDC a token, the other side nothing.",
    image: "/assets/img/rising-chart.jpg",
    alt: "A glowing line chart rising through glass panes",
  },
  {
    number: "0",
    heading: "No gas, no seed phrase",
    content: "Sign in with Face ID. A week-long session trades without prompts, and a relayer pays the network fees.",
    image: "/assets/img/no-gas-cat.jpg",
    alt: "An illustrated lavender cat in a hoodie being patted on the head beside a glowing phone in a cheering stadium",
  },
  {
    number: "38",
    heading: "Chains you can deposit from",
    content: "On mainnet, NEAR Intents brings USDC in from 38 chains, confidentially, straight to your account.",
    image: "/assets/img/stats-deposits.webp",
    alt: "Deposits from many chains converging through NEAR Intents into one USDC balance",
  },
];
