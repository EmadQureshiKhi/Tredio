# Attention index method

This is how Tredio turns raw attention into the 0 to 100 index the registry stores.
The same method runs in two places that must agree: `src/method.ts` and `src/plan.ts` (the oracle service), and `tee/src/method.rs` and `tee/src/plan.rs` (the OutLayer enclave build).
Both carry the same test vectors.

## Measurements

The backend's collector measures every tracked trend at the pace each source's budget allows and keeps the newest reading per source (`GET /v1/oracle/measurements`).
A reading older than its source's `maxAgeSec` is ignored, so a stalled collector removes a component instead of freezing the index.

| Source | Measurement | Notes |
| - | - | - |
| Elfa (X and Telegram) | Mentions of the trend's keywords over the last 24 hours | Keyed, paced by the backend |
| GDELT | News articles worldwide matching the keywords over the last day | Keyless |
| Bluesky | Posts matching any keyword over the last 24 hours | Keyless public AppView |
| Hacker News | Stories and comments mentioning a keyword over the last 24 hours | A boost, see below |
| Wikipedia | Human views of the trend's article over the last complete UTC day | A slow-moving baseline |
| Nansen (crypto only) | Net smart-money flow in USD over 24 hours | Shapes the index and gates new crypto trends |

## From measurement to a component in [0, 1]

For every count source with clip `C` and saturation `K`:

1. Clip outliers: `x1 = min(x, C)`.
2. Normalize on a log scale: `n = clamp(ln(1 + x1) / ln(1 + K), 0, 1)`.
   Attention is heavy-tailed, so the log scale keeps niche and mainstream trends on a usable range, and `K` is the level that counts as maximal attention.

Every measurement covers a whole day, so there is no time-of-day adjustment.

The Nansen component is `0.5 + 0.5 * tanh(F / scale)` for net flow `F`: neutral flow scores 0.5, inflows push it toward 1 and outflows toward 0.
It counts only beside at least one attention source, so smart money alone never moves an index.

## Combining components

`index = 100 * sum(w * n) / sum(w)` over the components that answered for this trend.
Weights renormalize over available sources, so one source being down shifts the mix instead of zeroing the index.
If no component answered, the trend is not reported this run.

| Source | Weight | Clip | Saturation `K` | `maxAgeSec` |
| - | - | - | - | - |
| Elfa | 0.6 | 10,000 | 5,000 | 43,200 |
| Bluesky | 0.35 | 10,000 | 1,000 | 7,200 |
| GDELT | 0.3 | 20,000 | 3,000 | 7,200 |
| Wikipedia | 0.25 | 5,000,000 | 150,000 | 172,800 |
| Nansen (crypto) | 0.2 | | scale 500,000 USD | 43,200 |
| Hacker News (boost) | 0.15 | 5,000 | 300 | 10,800 |

Hacker News is a boost: most topics never reach it, and a zero there says nothing about attention elsewhere.
It enters the weighted mean only when its component is above the index without it, so it lifts a tech topic and never drags down the rest.
The rule is continuous: at the point where the boost equals the index, including it changes nothing.

The value is rounded to 0.01 points and bounded to [0.01, 100] points, which the registry stores as `points * 1,000,000`.
The registry also clamps each update to `max_move_bps` of the last value, so a sudden step is spread over a few reports.

## What a run reports

- A run samples trends whose Up/Down series wait on a settlement observation first, then up to two new candidates while live slots are free, then the trends observed longest ago.
- A measured trend is reported when its heartbeat (420 s) is due, when it moved at least 1%, or when a series waits on its settlement; trends past half their heartbeat ride along when a report goes out anyway.
- A candidate lists when its index is at least 5 points; a crypto candidate also needs smart-money net inflow of at least 100,000 USD, unless an admin kept the topic.
- A topic that retired lists again as `<base>.2` up to `<base>.9`.
- Every report carries Hyperliquid mark prices for BTC, ETH, SOL, NEAR, HYPE and each live trend's asset, which the account contract's order guard reads.
- The first observation at or after a registered series expiry settles that series on chain.
- A run with nothing to report sends no transaction.
