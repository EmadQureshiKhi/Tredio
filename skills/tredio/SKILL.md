---
name: tredio
description: Read, verify and trade Tredio's attention markets on NEAR. Tredio lists internet trends, each with a 0 to 100 attention index that an oracle signs and the registry contract stores, and trades it through Up/Down outcome series, attention perps and trend coins. Use when an agent needs Tredio's API or MCP server, its contract ids and units, to check an index value or an AI review on chain instead of trusting the API, to pay for Tredio's x402 endpoints in USDC on NEAR, or to trade safely through a session key.
---

# Tredio

Tredio turns what the internet is talking about into markets on NEAR.
A radar proposes trends, a verifiable model on NEAR AI Cloud reviews each one, and an oracle scores each listed trend's attention from 0 to 100 and writes it to the `registry` contract.
Each trend gets Up/Down outcome series (24 h and 7 d) on Tredio's own order book, an attention perp (up to 3x) and a trend coin on a bonding curve; Hyperliquid perps on the trend's asset trade from the same account.
Tredio runs on NEAR testnet; every balance there is a test asset with no value.

## Contracts and units (testnet)

| Account | Role |
| --- | --- |
| `registry.tredio.testnet` | Trends, index checkpoints, series settlement values, attention fair value, Hyperliquid marks |
| `outcomes.tredio.testnet` | NEP-245 Up and Down tokens; a complete Up+Down set mints and redeems for 1 USDC |
| `book.tredio.testnet` | Order book for Up and Down against USDC |
| `perps.tredio.testnet` | Attention perps, isolated margin |
| `coins.tredio.testnet` | Trend coin factory; each coin is its own NEP-141, for example `topic-world-cup.coins.tredio.testnet` |
| `curation.tredio.testnet` | Fees owed to the account that first surfaced a trend |
| `accounts.tredio.testnet` | Factory of passkey accounts (`0u...` universal accounts) |
| `usdc.tredio.testnet` | Test USDC (NEP-141) with a public faucet |

The deployment file is `deployments/testnet.json`; the treasury is `tredio-treasury.testnet`.

- Index: 6 decimals on chain (`1000000` is one point, so `51880000` is 51.88); the API and the MCP tools answer in points.
- USDC and outcome tokens: 6 decimals.
- Trend coins: 18 decimals.
- Perp quantity: 18 decimals; one contract (`1e18`) is worth 1 USDC per index point.
- Hyperliquid marks on the registry: 8 decimals.
- Book prices: ticks of 0.001 USDC from 1 to 999; a winning token redeems 1 USDC.
- Times: unix seconds.

## How the index works

1. The radar and collectors read public sources (Bluesky, GDELT, Wikipedia, Hacker News, CoinGecko, GeckoTerminal, Elfa, Nansen) and propose candidates.
2. A verifiable NEAR AI Cloud model reviews each candidate; the signed evidence is stored, and its SHA-256 (`review_hash`) is written on chain with the listing.
3. The oracle computes each trend's index from the readings and sends `submit_report(report_json, signature)` to the registry.
4. The registry accepts a report only when `signature` is an ed25519 signature over SHA-256 of the exact `report_json` bytes by the key in `get_oracle`, the run id is higher than the last one, and the observation time is recent (`get_params`: `max_report_age`, `max_future_skew`).
5. It limits each move to `max_move_bps` of the previous value (logged as `index_clamped`), keeps the last 96 checkpoints per trend (`history(id)`), and moves trends between `active`, `cooling` and `retired` by the attention floor and its windows.
6. A trend is `fresh` while its last update is within `staleness_limit`; perps and anchored swaps refuse a stale index.

The oracle's enclave build runs on OutLayer (a TEE) with a signing key bound to that build.
The registry trusts exactly one key, the one `get_oracle` returns, and only its owner changes it, with `set_oracle` (logged as `oracle_changed`).
On testnet it still trusts the bootstrap key it was deployed with (`oracle.publicKey` in `deployments/testnet.json`) until it is switched to the enclave's key.
Tredio's API mirrors every checkpoint, so its history goes back further than the registry's 96.

### Verify, do not trust

- MCP `verify_index`: finds the `submit_report` transaction behind a trend's newest checkpoint, reads it from NEAR RPC, verifies the ed25519 signature with the registry's oracle key, and checks that the transaction succeeded and wrote that value.
- By hand: read `history({"id": ...})` and `get_oracle({})` on the registry; find the `submit_report` transaction to the registry whose report has that `observed_at` (any NEAR explorer); check `ed25519_verify(signature, sha256(report_json), key)`; confirm its `index_updated` event for the trend.
- Reviews: `GET /v1/reviews/{hash}` returns the evidence; its SHA-256 over the JSON with sorted keys must equal the trend's `review_hash`, and `signature` (an Ethereum `personal_sign` signature over `signedText`, secp256k1) must recover `signingAddress`; `signatureKind: "provider_tee"` means the model's TEE signed it.
  MCP `get_review` runs both checks.
- Trends an admin added by hand have no review hash.

## API

The API serves JSON at `TREDIO_API_URL` (locally `http://localhost:4000`; `GET /` lists the main routes).

| Route | Answer |
| --- | --- |
| `GET /v1/status` | Services, oracle freshness, chain head, service wallets (503 when something is down) |
| `GET /v1/trends` | Live trends with index, peak, 24 h change and latest readings; `?all=1` adds retired ones |
| `GET /v1/trends/{identifier}` | One trend, 7 days of index points and source readings |
| `GET /v1/trends/{identifier}/stats` | Volume, traders, open interest, coin state |
| `GET /v1/trends/{identifier}/thread` | Calls and posts on the trend |
| `GET /v1/candidates` | Approved topics waiting for a live slot |
| `GET /v1/reviews/{hash}` | NEAR AI Cloud review evidence |
| `GET /v1/accounts/{account}` | Trading summary (`?optional=1`: `null` instead of 404) |
| `GET /v1/accounts/{account}/activity`, `/outcomes`, `/orders` | Trade history, outcome holdings, open book orders |
| `GET /v1/leaderboard/traders`, `GET /v1/callers/leaderboard` | Leaderboards |
| `GET /v1/hyperliquid/markets`, `/v1/hyperliquid/leaders` | Hyperliquid markets and the leaders to copy |
| `GET /v1/x402` | The paid resources (below) |

Identifiers are `<class>:<slug>` in lowercase, for example `topic:world-cup`; a trend listed again after retiring gets `.2` to `.9`.
Signed-in routes (alerts, Autopilot rules, links) take a NEP-413 sign-in at `POST /v1/auth/session` with recipient `tredio.bid`.

## MCP server

`packages/mcp` (`tredio-mcp`) serves the tools on stdio with Bun:

```sh
claude mcp add tredio --env TREDIO_API_URL=http://localhost:4000 -- bun /path/to/Tredio/packages/mcp/src/bin.ts
```

Tools: `get_status`, `list_trends`, `get_trend`, `get_index_history`, `get_market`, `get_perp_market`, `get_coin`, `get_review`, `verify_index`, `get_account`, `get_leaders`, `list_candidates`, `get_paid_api`.
With `TREDIO_X402_ACCOUNT` and `TREDIO_X402_PRIVATE_KEY` in its env it also offers `buy_trend_history`, which pays at most `TREDIO_X402_MAX_USDC` (default 0.05) per call.
See `packages/mcp/README.md` for Claude Desktop and `.mcp.json` setups.

## Paid API (x402)

Tredio sells premium data per call with x402 v2, using its NEAR `exact` scheme (`specs/schemes/exact/scheme_exact_near.md` in the x402 repository).
The payer needs USDC and a full-access key on any NEAR account, but no NEAR and no Tredio sign-in: Tredio's relayer submits the payment and pays the gas.

| Resource | Price | Answer |
| --- | --- | --- |
| `GET /v1/x402/trends/{identifier}/history?from=&to=` | 0.01 USDC | Every index checkpoint since listing (or in the range) and every per-source reading with metric and window |
| `POST /v1/x402/backtests` with `{"rule": ..., "days": 1 to 30}` | 0.02 USDC | An Autopilot rule backtested on the index history and Hyperliquid candles |

The flow:

1. Request the resource; it answers `402` with a `PAYMENT-REQUIRED` header (base64 JSON, also the body) whose `accepts[0]` holds `{"scheme": "exact", "network": "near:testnet", "amount": "10000", "asset": "usdc.tredio.testnet", "payTo": "tredio-treasury.testnet", "maxTimeoutSeconds": 60}` (and `extra` metadata).
2. Sign a NEP-366 delegate action from your account to `asset` with exactly one `ft_transfer` of `amount` to `payTo`, 1 yoctoNEAR attached, a nonce above your key's current nonce, and `max_block_height` at most 60 blocks after the final block.
3. Repeat the request with `PAYMENT-SIGNATURE: base64(JSON {x402Version: 2, accepted: <the requirements>, payload: {signedDelegateAction: <base64 Borsh SignedDelegate>}})`.
4. The API checks it against the chain, produces the answer, submits the transfer and replies `200` with `PAYMENT-RESPONSE: base64(JSON {success, transaction, network, payer, amount})`.

- A refused payment answers `402` again with the reason in `error` (for example `insufficient_funds`, `invalid_exact_near_payload_delegate_action_nonce_already_used`); a malformed header answers `400`.
- A request that fails on its own (unknown trend, a rule the backtester cannot run) answers its error and charges nothing.
- One signed payment serves one request.
- Function-call keys and session keys cannot pay (NEP-141 transfers attach 1 yoctoNEAR), so passkey accounts do not pay x402; use a wallet account.
- The paid routes are on only where the API has a relayer configured; `GET /v1/x402` says `enabled`.
- In TypeScript, `x402Fetch` from `@tredio/chain` does steps 1 to 4 within a spending limit; `scripts/x402-demo.ts` runs the whole flow on testnet.

## Trading safely

Two ways to trade: a NEAR wallet calls the contracts itself, or a Tredio passkey account trades through a session key its owner approved.

### Passkey accounts and sessions

- A passkey account is a universal account (`0u...`) running Tredio's account contract; it has no full-access key and no seed phrase.
- The owner's passkey (WebAuthn P-256, verified on chain) signs owner requests to add or revoke sessions, freeze all of them, withdraw and upgrade.
- A session is a function-call key (usually a gas key) on the account itself that can call only `session_call`, with typed actions only: `swap`, `mint_sets`, `redeem_sets`, `redeem_winnings`, `book_withdraw`, `perp_open`, `perp_close`, `claim_curation`, `faucet`, `hl_order`, `hl_leverage` (and `top_up_gas` from account code v2).
- Each session has an expiry (at most 30 days; the app asks for 7), a scope (`outcomes`, `perps`, `hyperliquid`) and a gross daily USDC outflow limit that inflows never offset (the app asks for 500 USDC a day).
- Read a session with `session({"public_key": ...})` or all of them with `sessions({})` on the account; `frozen({})` says whether the owner froze them.
- Autopilot and agents get a session of their own (Autopilot's is labelled `autopilot` and scoped to Hyperliquid), so the owner can cap and revoke it without touching the rest.

### On-chain guards

- Session swaps on the book are always anchored: the worst price is within 0.10 USDC of the attention-implied fair value (`fair_up` on the registry), and the index must be fresh, or the swap refunds.
- Perps: open with `acceptable_index` as your slippage bound; leverage is at most 3x at open (`leverage_bps` up to 30000), maintenance margin is 10%, a trade costs 10 bps of notional, and open, close and liquidate refuse a stale index.
- Hyperliquid orders from a session must be within 2% of the registry's fresh mark for that asset, and leverage changes at most 10x; the account builds the order's EIP-712 digest on chain and asks Chain Signatures (`v1.signer-prod.testnet`, path `hyperliquid`) to sign it.

### Habits

- Read `index_of` (or MCP `get_trend`) first and skip a trend whose `fresh` is false.
- Always pass a `min_out`, a `limit_tick` or an `acceptable_index`; never trade unbounded.
- Size from the depth (`depth` on the book, MCP `get_market`) and keep a session's daily limit small.
- Wallets register storage (`storage_deposit`) on `usdc`, `outcomes`, `book` and `perps` before their first trade there.
- Buying Up from a wallet: `ft_transfer_call` on `usdc.tredio.testnet` to `book.tredio.testnet` with `msg` `{"swap": {"series": <id>, "side": "up", "limit_tick": null, "min_out": "<raw tokens>", "anchored": true}}`, 1 yoctoNEAR attached.
- Opening a perp from a wallet: `ft_transfer_call` of the margin to `perps.tredio.testnet` with `msg` `{"open": {"trend": "<id>", "is_long": true, "leverage_bps": 20000, "acceptable_index": <raw index>, "deadline": null, "owner": null}}`.
- Test USDC: call `faucet({})` on `usdc.tredio.testnet` (currently 1000 USDC per draw, once an hour per account; `faucet_info` tells the next time); a passkey account draws through its session's `faucet` action.
