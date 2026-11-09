# For judges

Tredio is an attention market built on NEAR primitives: passkey universal accounts, gas-key sessions, an oracle built for an OutLayer enclave, NEAR AI Cloud review, Chain Signatures for Hyperliquid, and NEAR Intents for deposits.
This page lists every claim with the place to see it and a way to check it yourself, and ends with what is not finished.
Everything runs on NEAR testnet.
The hosted app at app.tredio.bid goes live before judging; until then, run it locally (README, "Run it") and check the on-chain claims with `pnpm verify`, which needs no hosting.

## In five minutes

1. Open [app.tredio.bid](https://app.tredio.bid) and sign in with Face ID or a fingerprint.
   You get a NEAR account (`0u...`) derived from your passkey, with no seed phrase and no NEAR to buy.
2. Take test USDC from the faucet in the account sheet, open a trend, and buy Up.
   No second prompt and no gas: the trade goes out on your session's gas key.
3. Open the status page to see the oracle's last run and every service wallet, gas key and nonce lane.
4. Clone the repository and run `pnpm install && pnpm verify` to check the claims below against testnet.

## Claims and how to check them

| Claim | Where to see it | How to check |
| --- | --- | --- |
| A passkey creates a NEAR account with no seed phrase | Sign in on the app | `pnpm verify` reads each account's `owner_key` (a `p256:` key) and asks the factory `accounts.account_id_of` for the account that key maps to |
| The owner is checked on chain, not by a server | [`contracts/account/src/webauthn.rs`](contracts/account/src/webauthn.rs) | `owner_execute` verifies the WebAuthn P-256 assertion with the `p256_verify` host function; the relayer cannot fake one |
| Every user account runs published code, which only its own passkey can change | [`deployments/testnet.json`](deployments/testnet.json) `globalCode.account` and `globalCode.accountV2` | `view_account` on any `0u...` account shows `global_contract_hash` `J1GvtY5x...` (v1, the hash the factory's `config` names) or `BsFqhAcY...` (v2); only the passkey's own `upgrade` action switches it |
| Trades need no prompt and no gas | The trade ticket after sign-in | Sessions are NEP-611 gas keys with typed actions and a daily USDC cap; `sessions` and `view_access_key` on an account show them |
| Only the oracle key can move the index | [`contracts/registry/src/oracle.rs`](contracts/registry/src/oracle.rs) | `get_oracle` on `registry.tredio.testnet`; every `submit_report` is checked with `env::ed25519_verify`, an increasing run id, a time window and a 50% move clamp; today that key is the bootstrap key (see the last section) |
| The oracle is built to run in a TEE | [`apps/oracle/docs/tee.md`](apps/oracle/docs/tee.md) | The OutLayer run recorded in [`deployments/testnet-proofs.json`](deployments/testnet-proofs.json) has an attestation with a TDX quote over the wasm hash; that run carries Hyperliquid marks only, since the enclave cannot reach the collectors' readings until the API is hosted |
| The enclave build is reproducible | [`apps/oracle/tee/build.sh`](apps/oracle/tee/build.sh) | With the pinned toolchain, `pnpm verify --build` rebuilds it and compares the sha256 with the attested run's |
| AI review is verifiable | [`backend/src/ai/nearai.ts`](backend/src/ai/nearai.ts) | Answers without a `provider_tee` signature are refused; `GET /v1/reviews/:hash` serves the signed evidence with the exact request and response, and the MCP server's `get_review` recomputes both hashes and checks the signature itself |
| A NEAR account signs Hyperliquid orders | [`contracts/account/src/hyperliquid.rs`](contracts/account/src/hyperliquid.rs) | Transaction [`DDkP3q4U...`](https://testnet.nearblocks.io/txns/DDkP3q4UkhrcN7AWragXMzwn5f4nGo8CXbhnVdBWWBAF) logs `hyperliquid_signed` and calls `v1.signer-prod.testnet` |
| Hyperliquid orders are guarded on chain | Same file | A session can only sign within 2% of a fresh oracle mark (two minutes old at most on account code v1, five on v2), at most 10x leverage; the unit tests cover each refusal; v2 also binds the mark to the signed asset (H-1 in [AUDIT.md](contracts/AUDIT.md)), and testnet accounts still run v1 |
| Deposits from any chain | Deposit page | 1Click quotes from [`packages/intents`](packages/intents); on testnet the quotes are dry runs, since 1Click settles on mainnet |
| Services run on gas-key lanes | Status page | `view_access_key` on `tredio-keeper.testnet`, `tredio-mm.testnet` and `tredio-relayer.testnet` shows gas keys with several nonces |
| The same code is ready for mainnet | [MAINNET.md](MAINNET.md), [`deployments/mainnet.json`](deployments/mainnet.json) | `cd contracts && cargo test -p tredio-sandbox-tests --test mainnet` deploys the mainnet plan on a local NEAR sandbox against the code mainnet runs today for Circle's USDC and Rhea, and trades through to a coin graduating into a Rhea pool; `grep -rn "#mainnet"` lists what differs |
| Paid signals are committed before anyone can read them | [`backend/src/signals`](backend/src/signals) | The API takes a signal only with a USDC transfer from the leader's account whose memo is the signal's SHA-256 (`tredio-signal:<hash>`), and early access only with a payment to the leader's account (`tredio-signals:<identity>`), both read from the NEP-141 events; `pnpm verify` checks the recorded pair |
| Autopilot's key can live in a TEE, inside a policy the account owns | [`packages/custody`](packages/custody), "Policy wallets" in [`apps/autopilot/README.md`](apps/autopilot/README.md) | `pnpm verify` reads `get_wallet_policy` on `outlayer.testnet` for the recorded wallet (its controller is the passkey account, which stored the policy and froze and unfroze it) and the `session_call` the wallet's enclave signed to that account; `bun scripts/policy-wallet.ts outside` shows the enclave refusing calls outside the policy before signing |
| Agents can use and pay for the data | [`packages/mcp`](packages/mcp), [`backend/src/x402`](backend/src/x402) | `GET /v1/x402` lists the paid resources; a paid route answers 402 with x402 v2 NEAR `exact` requirements, settles a signed USDC delegate action through Tredio's relayer, and returns the data; [`scripts/x402-demo.ts`](scripts/x402-demo.ts) pays one on testnet |

## Testnet records

- Contracts: [`registry`](https://testnet.nearblocks.io/address/registry.tredio.testnet), [`outcomes`](https://testnet.nearblocks.io/address/outcomes.tredio.testnet), [`book`](https://testnet.nearblocks.io/address/book.tredio.testnet), [`perps`](https://testnet.nearblocks.io/address/perps.tredio.testnet), [`coins`](https://testnet.nearblocks.io/address/coins.tredio.testnet), [`curation`](https://testnet.nearblocks.io/address/curation.tredio.testnet), [`accounts`](https://testnet.nearblocks.io/address/accounts.tredio.testnet), [`usdc`](https://testnet.nearblocks.io/address/usdc.tredio.testnet).
- Passkey accounts from the end-to-end runs: [`0ugt5v5y...`](https://testnet.nearblocks.io/address/0ugt5v5y5rdhyhndtyhrwrkp5rxrmxhpfbrcx9ets3g94pjsdjt330) (script) and [`0u5rr3y2...`](https://testnet.nearblocks.io/address/0u5rr3y2bqwn16dvh33rwry06bpnyj97j5j9rk2gd0vyj0ncyy5nf0) (browser).
- An x402 payment: [`8o1HFa5i...`](https://testnet.nearblocks.io/txns/8o1HFa5i3AfemE8FYm6HDFNAGGxZtQnxh622u22jaoZ1), 0.01 USDC for a trend's full history, signed as a delegate action by `tredio.testnet` (a project account playing the agent) and submitted by Tredio's relayer.
- A curation reward claimed: the account that surfaced an end-to-end test trend claimed its fee share, 0.012574 USDC from `curation`, through its session key in [`8zHEn4y9...`](https://testnet.nearblocks.io/txns/8zHEn4y9Hrq6DWw98UcvCHBXrTaNpnXRF6BUxB2ijeqM), as the Portfolio page's Claim button does.
- A paid signal: the leader's commitment [`3PZMfvkS...`](https://testnet.nearblocks.io/txns/3PZMfvkSWy3ga6GW47ZXUBpASi24yRYg7sTbQ2NQsPf1) (0.000001 USDC to the treasury, the signal's hash as the memo), then a follower's 1 USDC early-access payment to the leader [`9swKsrx7...`](https://testnet.nearblocks.io/txns/9swKsrx7Z5xfR5HitX2BkcfhfX1DoMSLzFQA1ZhBk81g); both accounts are project-owned passkey accounts from [`scripts/signals-demo.ts`](scripts/signals-demo.ts).
- A settled Up/Down series: a 15-minute World Cup series opened by [`4mxS6GSb...`](https://testnet.nearblocks.io/txns/4mxS6GSbgofhyyK4iza2QubUnm7u9vVyc6KuXTqj5cpF), its settlement value captured by the registry on the oracle's first report after expiry, and settled Down by the keeper in [`2YNerBhh...`](https://testnet.nearblocks.io/txns/2YNerBhhpGTNGbri9qfPjSxxqU5Pw7qofGG874LKwGBP).
- An OutLayer run of the enclave build anyone can reproduce from the repository: [`4WKiUBZ3...`](https://testnet.nearblocks.io/txns/4WKiUBZ38SWfwT1ptEeHJNvWNX1ywRCK31Pa9gZp39D6), wasm `434381e4...`, enclave key `ed25519:8qDVQ9Ay...`.
- A trend coin graduated from its curve into a Rhea pool: `topic:godzilla-minus-zero`'s coin filled its curve to 2,000 USDC, then the keeper ran the five steps ([`8Th2vJY6...`](https://testnet.nearblocks.io/txns/8Th2vJY65bhgmcRHXoLLAhv97NKWsP7hw2hVAQpTUQSi) creates the pool, [`57W1Juk1...`](https://testnet.nearblocks.io/txns/57W1Juk1XCA1LQMrmqeExmbiLwQHNGJyxnxacei94qpF) adds the liquidity), and pool 2909 on `ref-finance-101.testnet` holds the coin and 2,015.72 USDC.
- Trends listed from a NEAR AI Cloud review, the review's hash stored with each in the registry: `equity:tsla` and `topic:godzilla-minus-zero` (one review, `5133101e...`, model `z-ai/glm-5.3-flash`, signed `provider_tee` evidence at `GET /v1/reviews/5133101e64f60150c5ecdb0f4d1dd84afbdf984b92cc1caf4786f63c621cd2b7`) and `person:stephen-miller` (`b6048fd7...`).
- Autopilot on an OutLayer policy wallet: one passkey request [`C3vFoA6K...`](https://testnet.nearblocks.io/txns/C3vFoA6KMx1tVeSGtTCq7Yj59Jni8euELWMGzC9XiSLi) stored the wallet's policy with the account `0um1v5w8...` as controller and added Autopilot's session for the wallet's key; the enclave signed a `session_call` to the account in [`GT3RLHyR...`](https://testnet.nearblocks.io/txns/GT3RLHyRq5B6nMRfa2qhJheeUNy72CTsWn37eNAos2zM), which the account's v2 code refused (see the last section); the passkey froze the wallet in [`HbcVYSJT...`](https://testnet.nearblocks.io/txns/HbcVYSJTRRZ7ES6PCKt9t94z2dFU6TiDZQGnt4BXDaKF), the enclave and the executor refused while frozen, and it unfroze it in [`3rLBDand...`](https://testnet.nearblocks.io/txns/3rLBDandCdTQAT2aS7kt1CFoP8CjzF34YTkwJ7QEZd9K).
- The records `pnpm verify` checks are listed in [`deployments/testnet-proofs.json`](deployments/testnet-proofs.json).

## Tracks

- **DeFi:** an on-chain order book for Up/Down outcomes, attention perps, Hyperliquid perps through Chain Signatures, deposits through 1Click.
- **Memecoins:** one trend coin per trend on a bonding curve whose floor ratchets with peak attention, graduating into Rhea.
- **Social money:** public calls with a hit-rate leaderboard, copy-trading, paid private signals committed on chain, a curation fee share for the account that surfaced a trend.
- **Agent economy:** an MCP server, an agent skill, x402 endpoints paid in USDC on NEAR, and Autopilot trading through a revocable on-chain grant, optionally signed by an OutLayer policy wallet the account controls and can freeze.

## What is not finished, said plainly

- The hosted app, website and API go live with hosting before judging; today they run locally against testnet.
- The registry still trusts the bootstrap oracle key.
  The enclave build runs on OutLayer and its signatures verify the way the registry checks them, but the enclave reads the collectors' readings from the public API, so the switch to the enclave key (one `set_oracle` transaction, visible on chain) happens once the API is hosted.
  `pnpm verify` prints the key the registry trusts.
- Account code v2 is published on testnet and new accounts move onto it in their first request, but accounts made before 2026-11-06 run v1, where H-1 (the Hyperliquid mark not bound to the signed asset) stays open until their passkey upgrades them in Settings; the registry's half of the fix is live for every account.
- Crypto candidates the radar approves list only once smart-money inflow confirms them (Nansen), so the trends listed from NEAR AI reviews so far are topics, people and equities; the first live trends (World Cup, AI agents) were added by hand and carry no review.
- Hyperliquid answers "user does not exist" for derived addresses that hold no Hyperliquid testnet USDC; the orders are signed and sent, and they fill once an address is funded.
- 1Click settles only on mainnet, so testnet deposits stop at a dry quote.
- Mainnet is not deployed: the code, the deploy script and a sandbox rehearsal are ready, and the accounts and funds are not ([MAINNET.md](MAINNET.md)).
  Hyperliquid withdrawals and the NEAR Intents return route have been checked against Hyperliquid's signing vectors and testnet, not yet with funds.
- Autopilot's policy wallets stop one step short on chain: OutLayer's enclave signs only as the wallet's own account, and account code v1 and v2 take `session_call` only from the account's own keys, so the enclave's call reaches the account and is refused.
  The account code change that accepts it (a `session_call` sent directly by the implicit account of one of the account's session keys) is described in [`apps/autopilot/README.md`](apps/autopilot/README.md); until accounts run it, the executor waits and the app keeps the option closed.
  The mainnet NEAR Intents Agent API path is built and tested offline, and waits for a partner key.
- The collectors run on Tredio's server, outside the enclave; [`apps/oracle/docs/tee.md`](apps/oracle/docs/tee.md) says what the attestation does and does not prove.
