# For judges

Tredio is an attention market built on NEAR primitives: passkey universal accounts, gas-key sessions, an oracle built for an OutLayer enclave, NEAR AI Cloud review, Chain Signatures for Hyperliquid, and NEAR Intents for deposits.
This page lists every claim with the place to see it and a way to check it yourself, and ends with the scope of this build.
Everything runs on NEAR testnet.
The app is live at app.tredio.bid, with its API at api.tredio.bid; it also runs locally (README, "Run it"), and `pnpm verify` checks the on-chain claims without either.

## In five minutes

1. Open [app.tredio.bid](https://app.tredio.bid) and sign in with Face ID or a fingerprint.
   You get a NEAR account (`0u...`) derived from your passkey, with no seed phrase and no NEAR to buy.
2. Take test USDC from the faucet in the account sheet, open a trend, and buy Up.
   No second prompt and no gas: the trade goes out on your session's gas key.
3. Open the status page to see the oracle's last run and every service wallet, gas key and nonce lane.
4. Clone the repository and run `pnpm install && pnpm verify` to check the claims below against testnet.

## Without any of the team's keys

A fresh clone needs no secrets to check the claims:
- `pnpm install && pnpm verify --chain-only` reads NEAR testnet (and the API, for the checks that need it: https://api.tredio.bid or `TREDIO_API_URL`, skipped when none answers) and checks every claim below; it sends nothing and needs no key.
  "Deployed code is this source" also needs the builds: add `--rebuild` to make the reproducible ones with Docker (a few minutes per contract).
- `pnpm verify` then runs every package's test suite too; database tests skip without `TEST_DATABASE_URL`, and the run says so.
- `pnpm test`, `pnpm typecheck` and `pnpm lint` need nothing else; `cd contracts && cargo test --workspace` runs the unit tests and the sandbox flows on a local NEAR node.
- Running the services yourself needs their own keys (service accounts, the oracle's report key, data-source API keys), so for the app use the hosted one.

## Claims and how to check them

| Claim | Where to see it | How to check |
| --- | --- | --- |
| A passkey creates a NEAR account with no seed phrase | Sign in on the app | `pnpm verify` reads each account's `owner_key` (a `p256:` key) and asks the factory `accounts.account_id_of` for the account that key maps to |
| The owner is checked on chain, not by a server | [`contracts/account/src/webauthn.rs`](contracts/account/src/webauthn.rs) | `owner_execute` verifies the WebAuthn P-256 assertion with the `p256_verify` host function; the relayer cannot fake one |
| Every user account runs published code, which only its own passkey can change | [`deployments/testnet.json`](deployments/testnet.json) `globalCode.account`, `accountV2` and `accountV3` | `view_account` on any `0u...` account shows `global_contract_hash` `J1GvtY5x...` (v1, the hash the factory's `config` names), `BsFqhAcY...` (v2) or `AiQw6Q2m...` (v3, a reproducible build of commit `18dd319`); only the passkey's own `upgrade` action switches it, and new accounts move onto the newest in their first request |
| Trades need no prompt and no gas | The trade ticket after sign-in | Sessions are NEP-611 gas keys with typed actions and a daily USDC cap; `sessions` and `view_access_key` on an account show them |
| Only the oracle key can move the index | [`contracts/registry/src/oracle.rs`](contracts/registry/src/oracle.rs) | `get_oracle` on `registry.tredio.testnet`; every `submit_report` is checked with `env::ed25519_verify`, an increasing run id, a time window and a 50% move clamp; since 2026-11-10 that key is the enclave's (`set_oracle` [`4hTjCm4N...`](https://testnet.nearblocks.io/txns/4hTjCm4NNoHMKqXpwNbow1FQao645KXJjN5ABbNHZ1Qv)) |
| The oracle runs in a TEE | [`apps/oracle/docs/tee.md`](apps/oracle/docs/tee.md) | The registry trusts only the key OutLayer derives for the enclave build; the run recorded in [`deployments/testnet-proofs.json`](deployments/testnet-proofs.json) has an attestation with a TDX quote over the wasm hash, and `pnpm verify` checks that the registry accepted the very report that run printed |
| The enclave build is reproducible | [`apps/oracle/tee/build.sh`](apps/oracle/tee/build.sh) | With the pinned toolchain, `pnpm verify --build` rebuilds it and compares the sha256 with the attested run's |
| AI review is verifiable | [`backend/src/ai/nearai.ts`](backend/src/ai/nearai.ts) | Answers without a `provider_tee` signature are refused; `GET /v1/reviews/:hash` serves the signed evidence with the exact request and response, and the MCP server's `get_review` recomputes both hashes and checks the signature itself |
| A NEAR account signs Hyperliquid orders | [`contracts/account/src/hyperliquid.rs`](contracts/account/src/hyperliquid.rs) | Transaction [`DDkP3q4U...`](https://testnet.nearblocks.io/txns/DDkP3q4UkhrcN7AWragXMzwn5f4nGo8CXbhnVdBWWBAF) logs `hyperliquid_signed` and calls `v1.signer-prod.testnet` |
| Hyperliquid orders are guarded on chain | Same file | A session can only sign within 2% of a fresh oracle mark (two minutes old at most on account code v1, five on v2 and v3), at most 10x leverage; the unit tests cover each refusal; v2 and v3 also bind the mark to the signed asset (H-1 in [AUDIT.md](contracts/AUDIT.md)) |
| Deposits from any chain | Deposit page | 1Click quotes from [`packages/intents`](packages/intents); on testnet the quotes are dry runs, since 1Click settles on mainnet |
| Services run on gas-key lanes | Status page | `view_access_key` on `tredio-keeper.testnet`, `tredio-mm.testnet` and `tredio-relayer.testnet` shows gas keys with several nonces |
| The same code is ready for mainnet | [MAINNET.md](MAINNET.md), [`deployments/mainnet.json`](deployments/mainnet.json) | `cd contracts && cargo test -p tredio-sandbox-tests --test mainnet` deploys the mainnet plan on a local NEAR sandbox against the code mainnet runs today for Circle's USDC and Rhea, and trades through to a coin graduating into a Rhea pool; `grep -rn "#mainnet"` lists what differs |
| Paid signals are committed before anyone can read them | [`backend/src/signals`](backend/src/signals) | The API takes a signal only with a USDC transfer from the leader's account whose memo is the signal's SHA-256 (`tredio-signal:<hash>`), and early access only with a payment to the leader's account (`tredio-signals:<identity>`), both read from the NEP-141 events; `pnpm verify` checks the recorded pair |
| Autopilot's key can live in a TEE, inside a policy the account owns | [`packages/custody`](packages/custody), "Policy wallets" in [`apps/autopilot/README.md`](apps/autopilot/README.md) | `pnpm verify` reads `get_wallet_policy` on `outlayer.testnet` for the recorded wallet (its controller is the passkey account, which stored the policy and froze and unfroze it) and the `session_call` the wallet's enclave signed to that account, which account code v3 took as its session's and signed through Chain Signatures; `bun scripts/policy-wallet.ts outside` shows the enclave refusing calls outside the policy before signing |
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
- Trends listed from a NEAR AI Cloud review, the review's hash stored with each in the registry: `equity:tsla` and `topic:godzilla-minus-zero` (one review, `5133101e...`, model `z-ai/glm-5.3-flash`, signed `provider_tee` evidence at `GET /v1/reviews/5133101e64f60150c5ecdb0f4d1dd84afbdf984b92cc1caf4786f63c621cd2b7`) and `person:stephen-miller` (`b6048fd7...`); all three retired during the oracle outage of 2026-11-07 (the registry ran out of NEAR for storage) and live again as `equity:tsla.2`, `topic:godzilla-minus-zero.2` and `person:stephen-miller.2`.
- Autopilot on an OutLayer policy wallet, in the order it happened on chain: one passkey request [`C3vFoA6K...`](https://testnet.nearblocks.io/txns/C3vFoA6KMx1tVeSGtTCq7Yj59Jni8euELWMGzC9XiSLi) stored the wallet's policy with the account `0um1v5w8...` as controller and added Autopilot's session for the wallet's key; the passkey froze the wallet in [`HbcVYSJT...`](https://testnet.nearblocks.io/txns/HbcVYSJTRRZ7ES6PCKt9t94z2dFU6TiDZQGnt4BXDaKF) (while frozen the enclave answered `wallet_frozen` and signed nothing, so that refusal has no transaction; `bun scripts/policy-wallet.ts freeze` prints it) and unfroze it in [`3rLBDand...`](https://testnet.nearblocks.io/txns/3rLBDandCdTQAT2aS7kt1CFoP8CjzF34YTkwJ7QEZd9K); the enclave then signed a `session_call` to the account in [`GT3RLHyR...`](https://testnet.nearblocks.io/txns/GT3RLHyRq5B6nMRfa2qhJheeUNy72CTsWn37eNAos2zM), which the account's v2 code refused; the passkey moved the account to v3 in [`97TmqfGi...`](https://testnet.nearblocks.io/txns/97TmqfGiSzj8ws9WmMNEW1yX7bCG1XvKCcazY3ZY5bLA), and the enclave's next `session_call` went through in [`ENCLocW8...`](https://testnet.nearblocks.io/txns/ENCLocW8Mk6KikN2nLgH56UQu8JoxFr2U56wPVn1ejKG), where the account signed the Hyperliquid action through Chain Signatures.
- The records `pnpm verify` checks are listed in [`deployments/testnet-proofs.json`](deployments/testnet-proofs.json).

## Tracks

- **DeFi:** an on-chain order book for Up/Down outcomes, attention perps, Hyperliquid perps through Chain Signatures, deposits through 1Click.
- **Memecoins:** one trend coin per trend on a bonding curve whose floor ratchets with peak attention, graduating into Rhea.
- **Social money:** public calls with a hit-rate leaderboard, copy-trading, paid private signals committed on chain, a curation fee share for the account that surfaced a trend.
- **Agent economy:** an MCP server, an agent skill, x402 endpoints paid in USDC on NEAR, and Autopilot trading through a revocable on-chain grant, optionally signed by an OutLayer policy wallet the account controls and can freeze.

## Scope

This build is the whole product on NEAR testnet, and the code is ready for mainnet.
What happens at the mainnet launch, and the choices made on purpose, are below.

### Testnet today, mainnet-ready code

- Mainnet is one switch (`NEAR_NETWORK=mainnet`): the code, the deploy script and a sandbox rehearsal against mainnet's own USDC and Rhea are ready, and the mainnet accounts are created and funded at launch ([MAINNET.md](MAINNET.md)).
- Deposits through NEAR Intents 1Click settle on mainnet; on testnet the app shows real dry quotes.
- Hyperliquid withdrawals and the NEAR Intents return route are checked against Hyperliquid's signing vectors and on testnet; their first funded run is part of the pre-mainnet checklist.
- Autopilot's mainnet policy wallets run through the NEAR Intents Agent API, built and tested offline; they go live with the partner key at launch.

### Demo activity

- Much of the activity you see is the team's: twelve invented demo traders (`mila_k`, `owenh`, `rubyreads` and others, listed in [`apps/activity`](apps/activity)) trade, call and post on a schedule from 2026-11-12 to 2026-11-26, so the screens show a working market.
  Their trades are real testnet transactions from their own passkey accounts and sessions, and their calls are signed like anyone's, but no real person is behind them.

### By design

- Only a passkey can change its account's code, so upgrades are opt-in: account code v3 is published, new accounts start on it, and earlier accounts move to it with one passkey prompt in Settings.
  Accounts made before 2026-11-06 keep v1's Hyperliquid guard until they do ([AUDIT.md](contracts/AUDIT.md), H-1), and policy wallets need v3; the registry's half of the H-1 fix covers every account.
- Crypto trends list once Nansen confirms smart-money inflow, a quality gate on the radar; the trends listed from NEAR AI reviews so far are topics, people and equities, and the first live trends (World Cup, AI agents) were added by hand without a review.
- Hyperliquid orders are signed through Chain Signatures and sent on testnet; they fill once an account's derived Hyperliquid address holds testnet USDC, and Hyperliquid answers "user does not exist" before that.
- A policy wallet holds about 0.15 NEAR for its own gas, which stays in the wallet after a revoke because its policy allows no transfers; on older account code the executor waits and the app points to the upgrade.
- The collectors run on Tredio's server and the enclave computes and signs the index from their readings; [`apps/oracle/docs/tee.md`](apps/oracle/docs/tee.md) says exactly what the attestation proves, and how moving the keyed sources into the enclave would extend it.
