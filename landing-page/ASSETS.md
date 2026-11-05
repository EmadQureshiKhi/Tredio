# Third-party assets

Images, logos and fonts on this site that come from someone else, where each came from, and the terms that allow its use here.
Everything else is Tredio's own work: the logo and its exports (sources in `assets/brand/`), and the UI scenes rendered from `assets/brand/visuals/studio.html`.

## Fonts

Both families are under the [SIL Open Font License 1.1](https://openfontlicense.org), which allows use, bundling and redistribution, including in commercial products.
The site loads them from Google Fonts at build time through `next/font/google` and serves them itself.

| Font | Use | Source | Licence |
| --- | --- | --- | --- |
| Hanken Grotesk (variable, 100 to 900) | Body, UI and sans headlines | [Google Fonts](https://fonts.google.com/specimen/Hanken+Grotesk), [project](https://github.com/marcologous/hanken-grotesk) | SIL OFL 1.1, Copyright 2021 The Hanken Grotesk Project Authors |
| Newsreader (variable, with optical sizes) | Display lines | [Google Fonts](https://fonts.google.com/specimen/Newsreader), [project](https://github.com/productiontype/Newsreader) | SIL OFL 1.1, Copyright 2020 The Newsreader Project Authors |

## Photos

| File | Source | Licence |
| --- | --- | --- |
| `public/assets/img/crypto-chart.jpg` | Unsplash (trading chart on a screen), resized to 2000 px | [Unsplash License](https://unsplash.com/license): free for commercial use, no attribution required |

## Generated images

Generated with Higgsfield.

| File | Where it is used |
| --- | --- |
| `public/assets/img/topics-islands.jpg` | How it works, first slide |
| `public/assets/img/attention-cat.jpg` | "Attention, scored 0 to 100" card |
| `public/assets/img/rising-chart.jpg` | "Each winning token pays 1 USDC" card |
| `public/assets/img/no-gas-cat.jpg` | "No gas, no seed phrase" card |
| `public/assets/img/launch-thumbnails.jpg` | Launch section background |

## Rendered images

Tredio's own UI scenes, rendered with `assets/brand/export.sh scenes`.
Every trend, account name and number in them is illustrative.

`about-review.webp`, `about-markets.webp`, `about-account.webp`, `example-near.webp`, `example-agents.webp`, `example-heatwave.webp`, `track-memecoins.webp`, `track-social.webp`, `track-defi.webp`, `track-agents.webp`, `stats-rounds.webp`, `stats-deposits.webp` (all in `public/assets/img`), `public/assets/video/hero-poster.webp`, and the link cards `src/app/opengraph-image.jpg` and `twitter-image.jpg`.

## Logos in "Built with"

Each logo is the vendor's own file, used unmodified, only to say which services Tredio uses, with no claim of endorsement or partnership; the section says so next to the logos.
A vendor without a published brand kit, or whose terms ask for written permission before its logo is shown, appears by name only.

| File | Source | Terms |
| --- | --- | --- |
| `public/assets/logos/near.svg` (white logo, no margin) | `Near_Logos.zip` from the [NEAR Narrative and Brand Hub](https://near-foundation.notion.site/NEAR-Narrative-and-Brand-Hub-2f5da22d7b6480629d80ccf2b57fb4f9), section "NEAR Brand Assets" | The hub is published for partners, ecosystem teams, media and collaborators. It grants no written licence, and the [near.org terms](https://www.near.org/terms-of-use) ask for prior written permission to use NEAR marks. To confirm with the NEAR Foundation before mainnet. |
| `public/assets/logos/near-intents.svg` (primary logo, white) | `NEAR_Intents_Logos_public.zip` from the same hub, section "NEAR Intents Brand Assets" | As NEAR. The NEAR Intents guidelines ask that the logo is not recoloured, distorted, cropped or rebuilt. |
| `public/assets/logos/near-ai.svg` (primary, white with colour) | [near.ai/brand](https://near.ai/brand), `https://near.ai/branding/logos/primary/` | The page gives usage guidance (clear space of 22% of the logo height, minimum width 120 px, colour marks for marketing) but no written licence for third parties. Shown with the label "NEAR AI Cloud". |
| `public/assets/logos/hyperliquid.svg` (`Hyperliquid_Light.svg`) | [Hyperliquid brand kit](https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit), "Hyperliquid SVG format.zip" | The kit is published for builders, with a ready-made "Powered by Hyperliquid" badge; it states no usage terms. |
| `public/assets/logos/nansen.svg` | [Nansen brand page](https://nansen.ai/brand) | [Nansen API terms](https://www.nansen.ai/legal/api): "Powered by Nansen" attribution with the logo or name. Linked to nansen.ai. |
| `public/assets/logos/coingecko.svg` | [CoinGecko brand kit](https://brand.coingecko.com/resources/brand-kit) | [CoinGecko attribution guide](https://brand.coingecko.com/resources/attribution-guide): logo linked to coingecko.com with "Data powered by" beside it, no implied partnership. The guide asks marketing uses to get in touch first. |
| `public/assets/logos/geckoterminal.svg` | [CoinGecko brand kit](https://brand.coingecko.com/resources/brand-kit) | Same attribution guide, "On-chain data powered by", linked to geckoterminal.com. |
| `public/assets/logos/wikipedia-wordmark.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Wikipedia-wordmark-en_(white).svg) | [Wikimedia trademark policy](https://foundation.wikimedia.org/wiki/Policy:Trademark_policy): unmodified, as a hyperlink to a Wikimedia site, without suggesting endorsement. |

By name only:

- **OutLayer**: no published brand kit, and the [OutLayer licensing note](https://github.com/fastnear/near-outlayer) grants no rights to its name or logo.
- **Rhea Finance**: no brand or media kit; its [terms](https://guide.rhea.finance/docs/rhea-finance-terms-of-services.md) reserve all trademarks.
- **Elfa**: no brand page; its [terms](https://www.elfa.ai/terms) require prior written permission to use its marks.
- **Bluesky**: its [brand guidelines](https://bsky.social/about/support/branding) grant no trademark licence and ask that its logo is not combined with other logos; naming the service needs no permission.

Hacker News and GDELT appear only in the legal pages, by name.
