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

## Photos and pictures

Every picture on the home page except the three example market scenes comes from the previous version of this site, which the owner directed us to reuse.

| File | Where it is used | Source |
| --- | --- | --- |
| `public/assets/img/crypto-chart.jpg` | How it works, oracle slide | Unsplash (trading chart on a screen), [Unsplash License](https://unsplash.com/license): free for commercial use, no attribution required |
| `public/assets/img/topics-cells.jpg` | Agent Economy track | Unsplash (fluorescent cell micrograph), [Unsplash License](https://unsplash.com/license) |
| `public/assets/img/topics-islands.jpg` | How it works, radar slide | Generated with Higgsfield |
| `public/assets/img/topics-wave.jpg` | "Chains you can deposit from" card | Generated with Higgsfield |
| `public/assets/img/attention-cat.jpg` | "Attention, scored 0 to 100" card | Generated with Higgsfield |
| `public/assets/img/rising-chart.jpg` | "Each winning token pays 1 USDC" card | Generated with Higgsfield |
| `public/assets/img/no-gas-cat.jpg` | "No gas, no seed phrase" card | Generated with Higgsfield |
| `public/assets/img/launch-thumbnails.jpg` | Launch section background | Generated with Higgsfield |
| `public/assets/img/crypto-act-narrative.jpg` | How it works, review slide | Previous site; source not recorded |
| `public/assets/img/topics-trend-every-day.jpg` | How it works, markets slide | Previous site; source not recorded |
| `public/assets/img/attention-eye.jpg` | How it works, account slide | Previous site; source not recorded |
| `public/assets/img/token-cards.jpg` | Memecoins track | Previous site; source not recorded |
| `public/assets/img/ai-thumbnails.jpg` | Social Money track | Previous site; source not recorded |
| `public/assets/img/topics-tiles.jpg` | DeFi track | Previous site; source not recorded |
| `public/assets/img/market-opens.webp` | "24-hour and 7-day rounds" card | Previous site; source not recorded |

The pictures marked "source not recorded" need their origin and licence confirmed before mainnet.

## Rendered images

Tredio's own UI scenes, rendered with `assets/brand/export.sh scenes`.
Every trend, account name and number in them is illustrative.

`example-near.webp`, `example-agents.webp`, `example-heatwave.webp` (in `public/assets/img`), and the link cards `src/app/opengraph-image.jpg` and `twitter-image.jpg`.
The hero film and its poster (`public/assets/video/`) are cut from the previous site's film, re-edited for Tredio in `video/`.

## Logos in "Built with"

Each logo is the vendor's own file, used unmodified, only to say which services Tredio uses, with no claim of endorsement or partnership; the section says so next to the logos.

| File | Source | Terms |
| --- | --- | --- |
| `public/assets/logos/near.svg` (white logo, no margin) | `Near_Logos.zip` from the [NEAR Narrative and Brand Hub](https://near-foundation.notion.site/NEAR-Narrative-and-Brand-Hub-2f5da22d7b6480629d80ccf2b57fb4f9), section "NEAR Brand Assets" | The [near.org terms](https://www.near.org/terms-of-use) ask for prior written permission to use NEAR marks; the team has that written permission (November 2026) for the NEAR, NEAR Intents and NEAR AI logos. |
| `public/assets/logos/near-intents.svg` (primary logo, white) | `NEAR_Intents_Logos_public.zip` from the same hub, section "NEAR Intents Brand Assets" | As NEAR. The NEAR Intents guidelines ask that the logo is not recoloured, distorted, cropped or rebuilt. |
| `public/assets/logos/near-ai.svg` (primary, white with colour) | [near.ai/brand](https://near.ai/brand), `https://near.ai/branding/logos/primary/` | The page gives usage guidance (clear space of 22% of the logo height, minimum width 120 px, colour marks for marketing), and the team has written permission for this logo (see NEAR above). Shown with the label "NEAR AI Cloud". |
| `public/assets/logos/hyperliquid.svg` (`Hyperliquid_Light.svg`) | [Hyperliquid brand kit](https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit), "Hyperliquid SVG format.zip" | The kit is published for builders, with a ready-made "Powered by Hyperliquid" badge; it states no usage terms. |
| `public/assets/logos/nansen.svg` | [Nansen brand page](https://nansen.ai/brand) | [Nansen API terms](https://www.nansen.ai/legal/api): "Powered by Nansen" attribution with the logo or name. Linked to nansen.ai. |
| `public/assets/logos/coingecko.svg` | [CoinGecko brand kit](https://brand.coingecko.com/resources/brand-kit) | [CoinGecko attribution guide](https://brand.coingecko.com/resources/attribution-guide): logo linked to coingecko.com with "Data powered by" beside it, no implied partnership. The guide asks marketing uses to get in touch first. |
| `public/assets/logos/geckoterminal.svg` | [CoinGecko brand kit](https://brand.coingecko.com/resources/brand-kit) | Same attribution guide, "On-chain data powered by", linked to geckoterminal.com. |
| `public/assets/logos/wikipedia-wordmark.svg` | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Wikipedia-wordmark-en_(white).svg) | [Wikimedia trademark policy](https://foundation.wikimedia.org/wiki/Policy:Trademark_policy): unmodified, as a hyperlink to a Wikimedia site, without suggesting endorsement. |

| `public/assets/logos/outlayer.png` | `logo-straight-line2d.png` from [outlayer.ai](https://outlayer.ai), trimmed of its transparent margin | No published brand kit, and the [OutLayer licensing note](https://github.com/fastnear/near-outlayer) grants no rights to its name or logo. Shown at the owner's direction; to confirm with the OutLayer team. |
| `public/assets/logos/rhea.svg` (symbol, set beside the name) | `landing-rhea-logo.svg` from [rhea.finance](https://rhea.finance) | No brand or media kit; its [terms](https://guide.rhea.finance/docs/rhea-finance-terms-of-services.md) reserve all trademarks. Shown at the owner's direction; to confirm with Rhea Finance. |
| `public/assets/logos/elfa.svg` | `elfa-lockup.svg` from [elfa.ai](https://www.elfa.ai) | Its [terms](https://www.elfa.ai/terms) require prior written permission to use its marks. Shown at the owner's direction; written permission to be obtained from Elfa. |
| `public/assets/logos/bluesky.svg` | [Bluesky brand assets](https://bsky.social/about/support/icons) (logo with wordmark, blue) | Its [brand guidelines](https://bsky.social/about/support/branding) grant no trademark licence and ask that its logo is not combined with other logos; here it sits in its own card. Shown at the owner's direction. |

Hacker News and GDELT appear only in the legal pages, by name.
