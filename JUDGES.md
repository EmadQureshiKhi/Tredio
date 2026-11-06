# For judges

Tredio is an attention market built on NEAR primitives: passkey universal accounts, gas-key sessions, an oracle signed inside an OutLayer enclave, NEAR AI Cloud review, Chain Signatures for Hyperliquid, and NEAR Intents for deposits.
This page lists every claim with the place to see it and a way to check it yourself.
Everything runs on NEAR testnet.

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
| Every user account runs the same immutable code | [`deployments/testnet.json`](deployments/testnet.json) `globalCode.account` | `view_account` on any `0u...` account shows `global_contract_hash` `J1GvtY5x...`, the hash the factory's `config` names |
| Trades need no prompt and no gas | The trade ticket after sign-in | Sessions are NEP-611 gas keys with four nonce lanes, typed actions and a daily USDC cap; `sessions` and `view_access_key` on an account show them |
| Only the oracle key can move the index | [`contracts/registry/src/oracle.rs`](contracts/registry/src/oracle.rs) | `get_oracle` on `registry.tredio.testnet`; every `submit_report` is checked with `env::ed25519_verify` |
| The oracle runs in a TEE | [`apps/oracle/docs/tee.md`](apps/oracle/docs/tee.md) | OutLayer's attestation of run [`73UDs4Yi...`](https://testnet.nearblocks.io/txns/73UDs4Yi8hNDu8xieSBJwmvrwFzPMcHium7xvkw3pcbm): `GET https://testnet-api.outlayer.ai/attestations/by-tx/73UDs4Yi8hNDu8xieSBJwmvrwFzPMcHium7xvkw3pcbm` returns a TDX quote over the wasm hash |
| The enclave build is reproducible | [`apps/oracle/tee/build.sh`](apps/oracle/tee/build.sh) | `pnpm verify --build` rebuilds it and prints the sha256 |
| AI review is verifiable | [`backend/src/ai/nearai.ts`](backend/src/ai/nearai.ts) | Answers without a `provider_tee` signature are refused; `GET /v1/reviews/:hash` serves the signed evidence for a trend's `review_hash` |
| A NEAR account signs Hyperliquid orders | [`contracts/account/src/hyperliquid.rs`](contracts/account/src/hyperliquid.rs) | Transaction [`DDkP3q4U...`](https://testnet.nearblocks.io/txns/DDkP3q4UkhrcN7AWragXMzwn5f4nGo8CXbhnVdBWWBAF) logs `hyperliquid_signed` and calls `v1.signer-prod.testnet` |
| Hyperliquid orders are guarded on chain | Same file | A session can only sign within 2% of an oracle mark under two minutes old, at most 10x leverage; the unit tests cover each refusal |
| Deposits from any chain | Deposit page | 1Click quotes from [`packages/intents`](packages/intents); on testnet the quotes are dry runs, since 1Click settles on mainnet |
| Services run on gas-key lanes | Status page | `view_access_key` on `tredio-keeper.testnet`, `tredio-mm.testnet` and `tredio-relayer.testnet` shows gas keys with several nonces |
| Agents can use and pay for the data | [`packages/mcp`](packages/mcp), [`backend/src/x402`](backend/src/x402) | `GET /v1/x402` lists the paid resources; a paid route answers 402 with x402 v2 NEAR `exact` requirements, settles a signed USDC delegate action through Tredio's relayer, and returns the data; [`scripts/x402-demo.ts`](scripts/x402-demo.ts) pays one on testnet |

## Testnet records

- Contracts: [`registry`](https://testnet.nearblocks.io/address/registry.tredio.testnet), [`outcomes`](https://testnet.nearblocks.io/address/outcomes.tredio.testnet), [`book`](https://testnet.nearblocks.io/address/book.tredio.testnet), [`perps`](https://testnet.nearblocks.io/address/perps.tredio.testnet), [`coins`](https://testnet.nearblocks.io/address/coins.tredio.testnet), [`curation`](https://testnet.nearblocks.io/address/curation.tredio.testnet), [`accounts`](https://testnet.nearblocks.io/address/accounts.tredio.testnet), [`usdc`](https://testnet.nearblocks.io/address/usdc.tredio.testnet).
- Passkey accounts from the end-to-end runs: [`0ugt5v5y...`](https://testnet.nearblocks.io/address/0ugt5v5y5rdhyhndtyhrwrkp5rxrmxhpfbrcx9ets3g94pjsdjt330) (script) and [`0u5rr3y2...`](https://testnet.nearblocks.io/address/0u5rr3y2bqwn16dvh33rwry06bpnyj97j5j9rk2gd0vyj0ncyy5nf0) (browser).
- The records `pnpm verify` checks are listed in [`deployments/testnet-proofs.json`](deployments/testnet-proofs.json).

## Tracks

- **DeFi:** an on-chain order book for Up/Down outcomes, attention perps, Hyperliquid perps through Chain Signatures, deposits through 1Click.
- **Memecoins:** one trend coin per trend on a bonding curve whose floor ratchets with peak attention, graduating into Rhea.
- **Social money:** public calls with a hit-rate leaderboard, copy-trading, a curation fee share for the account that surfaced a trend.
- **Agent economy:** an MCP server, an agent skill, x402 endpoints paid in USDC on NEAR, and Autopilot trading through a revocable on-chain grant.

## What is not finished, said plainly

- The registry still trusts the bootstrap oracle key.
  The enclave build runs on OutLayer and its signatures verify the way the registry checks them, but the enclave reads the collectors' readings from the public API, so the switch to the enclave key (one `set_oracle` transaction, visible on chain) happens once the API is hosted.
  `pnpm verify` prints the key the registry trusts.
- Testnet trends were added by hand in the admin panel until a NEAR AI Cloud key is in place, so no live trend carries a review hash yet.
- Hyperliquid answers "user does not exist" for derived addresses that hold no Hyperliquid testnet USDC; the orders are signed and sent, and they fill once an address is funded.
- 1Click settles only on mainnet, so testnet deposits stop at a dry quote.
- The collectors run on Tredio's server, outside the enclave; [`apps/oracle/docs/tee.md`](apps/oracle/docs/tee.md) says what the attestation does and does not prove.
- The screens, admin panel, website and much of the backend come from an earlier Tredio prototype on another chain; everything on NEAR was built during the hackathon.
