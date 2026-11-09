<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/hero-light.png">
  <img src="assets/readme/hero-dark.png" alt="Tredio: trade the world's attention on NEAR" width="960">
</picture>

Tredio turns what the internet is talking about into markets you can trade.
An AI radar finds trends, NEAR AI Cloud reviews them with verifiable models, an oracle built to run in an OutLayer enclave scores each one from 0 to 100, and the score lives on NEAR, where people trade it.
You sign up with Face ID, get a NEAR account with no seed phrase, and trade for a week without another prompt or a drop of gas.

[App](https://app.tredio.bid) · [Website](https://tredio.bid) · [API status](https://api.tredio.bid/v1/status) · [Judges' guide](JUDGES.md) · [For AI agents](AGENTS.md) · [llms.txt](https://tredio.bid/llms.txt)

Everything runs on NEAR testnet: the contracts, the oracle, the accounts and every service.
The hosted app, website and API at tredio.bid go live before judging; until then everything runs locally against testnet (see [Run it](#run-it)), and every on-chain claim can be checked with `pnpm verify`.

<img src="assets/readme/app-trend.png" alt="A trend page in the app: the World Cup's attention index over 24 hours, its stats, and the Up/Down ticket with Up at 79.3 cents" width="960">

## What you can trade

- **Up/Down series.** Will a trend's attention close above its opening level in 24 hours or 7 days?
  Each token pays 1 USDC if it is right, on an on-chain order book.
- **Attention perps.** Go long or short on the index itself, with isolated margin up to 3x and funding from the skew between longs and shorts.
- **Trend coins.** One token per trend on a bonding curve whose floor ratchets up with peak attention, graduating into a Rhea pool.
- **Hyperliquid perps** on the asset behind a trend, signed by your NEAR account.
- **Autopilot and copy-trading.** Rules with stop-loss, take-profit and loss limits, or follow a top Hyperliquid trader, executed through a session you can revoke.
- **Calls.** Post a public call from an unlinkable caller identity and build a hit rate on the leaderboard.

## Only on NEAR

Each of these is a NEAR primitive doing real work in the product, not a logo on a slide.

1. **Face ID accounts with no seed phrase and no gas.**
   A passkey creates a NEP-655 universal account (`0u...`) whose id is derived from the passkey itself, from inside the `accounts` factory, on a global contract.
   The account checks the passkey's P-256 signature on chain with the `p256_verify` host function, so no server can act as the owner.
   One prompt adds a week-long session key that is a NEP-611 gas key: it prepays its own gas and can only send typed trades, under a daily USDC cap for everything that moves USDC on NEAR (Hyperliquid actions move none on NEAR, so the price band and leverage limit below bound those).
   In the app: Sign in, then trade.
   Code: [`contracts/account`](contracts/account), [`contracts/accounts`](contracts/accounts), [`frontend/src/lib/account`](frontend/src/lib/account).
2. **An oracle built for an enclave.**
   The attention index is computed by a WASI build made for [OutLayer](https://outlayer.ai)'s TEE, pinned by its sha256; OutLayer derives an ed25519 key bound to that exact build (`bind: wasm`).
   The `registry` contract accepts a report only with the signature of the one oracle key it trusts (`env::ed25519_verify`), checks its run id and time window, and clamps every move.
   Status on testnet: the build runs on OutLayer with an attested TDX quote, but the registry still trusts a bootstrap key the team holds, because the enclave reads the collectors' readings from the public API, which goes live with hosting; the switch is one public `set_oracle` transaction, and `pnpm verify` prints which key is in use.
   In the app: every trend page shows its index history; the status page shows the oracle's last run.
   Code: [`apps/oracle/tee`](apps/oracle/tee), [`contracts/registry/src/oracle.rs`](contracts/registry/src/oracle.rs), method and trust model in [`apps/oracle/docs`](apps/oracle/docs).
3. **AI review you can verify.**
   Every candidate the radar finds is reviewed by NEAR AI Cloud's verifiable models.
   An answer without a `provider_tee` signature is refused, and the hash of the signed evidence is written on the trend in the registry.
   The API serves the exact request and response the signature covers, so anyone can recompute both hashes and check the signature against the signing address in the evidence without trusting Tredio; that the address belongs to NEAR AI's TEE is checked against NEAR AI's own attestation at [cloud.near.ai/verify](https://cloud.near.ai/verify).
   Status on testnet: the radar's candidates are reviewed by NEAR AI Cloud, with evidence signed in the provider's TEE, and `equity:tsla`, `topic:godzilla-minus-zero` and `person:stephen-miller` were listed from those reviews (live again as `.2` listings since the oracle outage of 2026-11-07, see JUDGES.md).
   Crypto candidates list only once smart-money inflow confirms them.
   In the app: the Verified chip on a reviewed trend opens the evidence.
   Code: [`backend/src/ai/nearai.ts`](backend/src/ai/nearai.ts), `GET /v1/reviews/:hash`.
4. **Hyperliquid perps from a NEAR account.**
   Your account contract builds the Hyperliquid order (msgpack action, connection id, EIP-712 digest) and asks [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures) (`v1.signer-prod.testnet`) to sign it with your account's own derived key.
   A session can only sign orders within 2% of a fresh oracle mark and up to 10x leverage, enforced on chain.
   Status on testnet: account code v3, whose guard binds the mark to the signed asset ([AUDIT.md](contracts/AUDIT.md), H-1) and which requires the passkey's user verification, is published; new accounts start on it, and older ones upgrade from Settings with one passkey prompt.
   In the app: the Perp tab's Hyperliquid market, on a trend with an asset; today's live trends are topics, and crypto trends (NEAR and Hyperliquid are queued) list once Nansen confirms smart-money inflow.
   Code: [`contracts/account/src/hyperliquid.rs`](contracts/account/src/hyperliquid.rs), [`packages/hyperliquid`](packages/hyperliquid).
5. **Deposits from any chain.**
   Deposits and withdrawals go through [NEAR Intents 1Click](https://docs.near-intents.org), so USDC on another chain lands in your NEAR account in one step.
   1Click settles on mainnet only; on testnet the app shows real dry quotes.
   In the app: Deposit.
   Code: [`packages/intents`](packages/intents), [`backend/src/deposits`](backend/src/deposits).
6. **A service fleet on gas keys.**
   The relayer, keeper and market maker each send through a gas key with parallel nonce lanes, so one slow transaction never blocks the next; the top-up service refills those keys and every service wallet from the treasury.
   In the app: the status page lists every wallet, key and lane.
   Code: [`packages/chain`](packages/chain), [`apps`](apps).
7. **Autopilot on a revocable on-chain grant, optionally signed in a TEE.**
   Turning on Autopilot adds a session labelled `autopilot` that can only trade Hyperliquid, under the same on-chain price and leverage guard, confirmed by reading the account.
   The session's key can live in an OutLayer custody wallet instead of with the executor: the account stores the wallet's policy (only the account itself as receiver, no NEAR attached, a call budget) as its controller and can freeze it with one passkey prompt, and account code v3 lets the wallet act for the session as its own implicit account.
   Stop-loss, take-profit and loss limits are enforced by the executor off chain.
   Status on testnet: an OutLayer enclave signed a `session_call` that a v3 account took as Autopilot's session and signed through Chain Signatures ([`ENCLocW8...`](https://testnet.nearblocks.io/txns/ENCLocW8Mk6KikN2nLgH56UQu8JoxFr2U56wPVn1ejKG)); the mainnet path through the NEAR Intents Agent API is tested offline.
   In the app: Autopilot (grant access, then "Policy wallet").
   Code: [`apps/autopilot`](apps/autopilot), [`backend/src/autopilot`](backend/src/autopilot), [`packages/custody`](packages/custody).
8. **Paid data for agents, settled in USDC on NEAR.**
   Premium API endpoints (full-resolution index history with every source reading, and Autopilot backtests) follow x402 v2's NEAR `exact` scheme: the API answers HTTP 402, the agent signs one USDC `ft_transfer` as a NEP-366 delegate action and sends it in `PAYMENT-SIGNATURE`, and Tredio's relayer submits it, so the agent needs no NEAR for gas.
   An MCP server and an agent skill describe the whole product to AI agents; the MCP server can also buy the paid history under a spending cap, and trade Up/Down, perps and coins and post calls for a user within the limits the user sets (an allowlist of tools, a USDC cap per call and a daily cap), from a passkey account's session key or the agent's own NEAR account.
   Code: [`backend/src/x402`](backend/src/x402), [`packages/chain/src/x402.ts`](packages/chain/src/x402.ts) (the paying client), [`packages/mcp`](packages/mcp), [`skills/tredio/SKILL.md`](skills/tredio/SKILL.md).
9. **Paid private signals, committed on chain first.**
   A leader publishes trade signals that stay sealed (AES-GCM under a weekly viewing key) until a delay the leader sets, and followers buy early access in USDC on NEAR, paid straight to the leader's account.
   Before the API takes a signal, its SHA-256 goes on chain in the memo of a 0.000001 USDC transfer from the leader's account, so nobody can change or backdate it; payments and commitments are read from the NEP-141 events the USDC contract logged.
   Autopilot copies each signal within the follower's caps while access lasts, and agents buy the same viewing keys over x402, paid to the leader.
   Positions on chain stay public; what is private is the signal and its timing, and Tredio's server, which sells the keys, can read every signal.
   Status on testnet: a channel, a committed signal ([`3PZMfvkS...`](https://testnet.nearblocks.io/txns/3PZMfvkSWy3ga6GW47ZXUBpASi24yRYg7sTbQ2NQsPf1)) and a follower's early-access payment ([`9swKsrx7...`](https://testnet.nearblocks.io/txns/9swKsrx7Z5xfR5HitX2BkcfhfX1DoMSLzFQA1ZhBk81g)), made by [`scripts/signals-demo.ts`](scripts/signals-demo.ts).
   In the app: Signals on a caller's profile, and Paid signals on Copy.
   Code: [`packages/autopilot/src/signals.ts`](packages/autopilot/src/signals.ts), [`backend/src/signals`](backend/src/signals), [`apps/autopilot/src/signals.ts`](apps/autopilot/src/signals.ts).

## How it works

<img src="assets/readme/pipeline.png" alt="How a trend becomes a market: the oracle's signed reports update the registry; the radar's NEAR AI review hash goes on the trend; markets read the registry; passkey accounts and the service fleet trade against the markets" width="960">

The radar proposes trends from public sources and NEAR AI Cloud reviews each one.
The oracle runs every minute: it reports a trend when its index moves 1% or at least every seven minutes, and Hyperliquid marks on every run; the signed report updates the index, records each series' opening and settlement values, and records the marks, and the keeper opens and settles series from them.
Markets read the registry: Up/Down series settle from it, perps use it as their price, coins ratchet their floor from its peak.
People trade from their own account contracts, and the services keep markets quoted, series settled and wallets funded.

<img src="assets/readme/app-status.png" alt="The status page: every service up, the oracle's last run, the NEAR head, and the service fleet's wallets and gas keys" width="960">

## Contracts on testnet

| Contract | Account | What it does |
| --- | --- | --- |
| `registry` | [`registry.tredio.testnet`](https://testnet.nearblocks.io/address/registry.tredio.testnet) | Trends, the signed index, series opening and settlement values, Hyperliquid marks |
| `outcomes` | [`outcomes.tredio.testnet`](https://testnet.nearblocks.io/address/outcomes.tredio.testnet) | NEP-245 Up and Down tokens; a complete set mints and redeems for 1 USDC |
| `book` | [`book.tredio.testnet`](https://testnet.nearblocks.io/address/book.tredio.testnet) | Order book for Up and Down against USDC: limit, post-only and market orders |
| `perps` | [`perps.tredio.testnet`](https://testnet.nearblocks.io/address/perps.tredio.testnet) | Attention perps: isolated margin up to 3x, funding, liquidation |
| `coins` | [`coins.tredio.testnet`](https://testnet.nearblocks.io/address/coins.tredio.testnet) | One NEP-141 per trend on a bonding curve, graduating into Rhea |
| `curation` | [`curation.tredio.testnet`](https://testnet.nearblocks.io/address/curation.tredio.testnet) | Fee share for the account that first surfaced a trend |
| `accounts` | [`accounts.tredio.testnet`](https://testnet.nearblocks.io/address/accounts.tredio.testnet) | Factory for passkey universal accounts on a global contract |
| `usdc` | [`usdc.tredio.testnet`](https://testnet.nearblocks.io/address/usdc.tredio.testnet) | Test USDC with a faucet (mainnet uses native USDC) |

Account ids, global code hashes and the oracle key are in [`deployments/testnet.json`](deployments/testnet.json).
Demo trades on testnet were made by project-owned accounts, so activity you see there is not organic.
The contracts were self-audited against the near-contract-audit checklist and then reviewed again in a separate AI review pass; findings, fixes, what is still open on testnet and the team's remaining powers are in [`contracts/AUDIT.md`](contracts/AUDIT.md).

## Ready for mainnet

The same code runs on NEAR mainnet: one switch (`NEAR_NETWORK=mainnet`) moves every service and the app to [`deployments/mainnet.json`](deployments/mainnet.json), which names Circle's native USDC, Rhea's `v2.ref-finance.near`, the `v1.signer` Chain Signatures contract and OutLayer's `outlayer.near`.
What is left is deploying and funding: [`contracts/scripts/deploy.sh mainnet`](contracts/scripts/deploy.sh) deploys only reproducible builds of a clean commit, so NearBlocks can verify every contract from this repository.
A mainnet rehearsal runs the whole plan on a local NEAR sandbox against the code mainnet runs today for USDC and Rhea, through to a trend coin graduating into a real Rhea pool:

```bash
cd contracts && cargo test -p tredio-sandbox-tests --test mainnet
```

What changes on mainnet, the steps and the budget are in [MAINNET.md](MAINNET.md).

## Repository

- [`contracts/`](contracts): the Rust contracts (registry, outcomes, book, perps, coins and coin, curation, accounts and account, test USDC), their unit tests and sandbox flows.
- [`apps/`](apps): the Bun services (relayer, keeper, market maker, Autopilot, top-up, oracle and its enclave build, indexer, Agent Market worker).
- [`backend/`](backend): the API on Postgres; [`frontend/`](frontend), [`admin/`](admin) and [`landing-page/`](landing-page): the app, the operator console and the website.
- [`packages/`](packages): shared TypeScript (NEAR client, typed contract calls, Hyperliquid, 1Click, Autopilot rules and signals, custody wallets, the MCP server); [`scripts/`](scripts): `verify`, the testnet demos and the dev runner.

<img src="assets/readme/repository.png" alt="What is in the repository: Rust contracts, Bun services and shared packages, the Hono backend and three Next.js sites" width="960">

<img src="assets/readme/tree.png" alt="Annotated file tree, with the account contract highlighted" width="960">

## Run it

You need Node 22, Bun 1.3 or later, pnpm 10, Postgres 16, and Rust with `cargo-near` for the contracts.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts the API, the services and the app against the testnet contracts, and prints what each needs in its `.env` (every app has a `.env.example`).
Contracts build and test with `pnpm build:contracts` and `pnpm test:contracts`; the sandbox flows run with `cd contracts && cargo test -p tredio-sandbox-tests`.
The launch film is a Remotion project in [`video/`](video).

## Check it yourself

```bash
pnpm verify
```

`pnpm verify` reads NEAR testnet and checks the claims in [JUDGES.md](JUDGES.md): every contract holds code, and that code hashes byte for byte like its build from this checkout (the reproducible build of the commit the contract or the account code names, or `pnpm build:contracts` for the coin code); user accounts run published global code and derive from their passkeys, a live session gas key, the oracle key the registry trusts and how fresh its last report is, a Hyperliquid order signed through Chain Signatures, OutLayer's record of an enclave run (it carries a TDX quote), an x402 payment, a curation claim, a paid signal and the policy wallet; then it runs every test suite.

## Security

The contracts get the checks any serious smart-contract codebase gets: an audit, static analysis, dependency scans and verified deployed code.
Details and how to rerun each one are in [SECURITY.md](SECURITY.md).

| Check | Result |
| --- | --- |
| Self-audit ([contracts/AUDIT.md](contracts/AUDIT.md)) | 11 findings, 10 fixed with a test each, 1 open by design |
| Deployed code is this source (`pnpm verify`, `near contract verify`) | 10 of 10 code hashes match byte for byte; the 8 contracts are reproducible builds (SourceScan's Docker image, NEP-330) that NearBlocks can verify once the repository is public |
| NEAR rules (`pnpm security`) | private callbacks, token receivers check their token, overflow checks, no `unsafe`, the signer used only to require a direct call: all hold |
| Clippy security lints on the wasm build | 0 panics; every truncating cast, unwrap and slice index reviewed |
| BlockSec's Rustle, the NEAR static analyzer ([contracts/RUSTLE.md](contracts/RUSTLE.md)) | 0 high, 0 medium; 2 low findings, both fixed |
| `cargo deny` on the deployed wasm's dependencies | advisories, bans and sources ok |
| Tests | 176 unit tests (84% line coverage), 17 integration flows on a real NEAR node including a mainnet rehearsal, end to end on testnet |

```bash
pnpm security
```

## For AI agents

- [AGENTS.md](AGENTS.md): how the repository is laid out and how to work in it.
- [`packages/mcp`](packages/mcp): an MCP server for trends, markets, accounts and index verification, with trade tools that are dry runs by default and send only within the user's spending policy.
- [`skills/tredio/SKILL.md`](skills/tredio/SKILL.md): a skill that teaches an agent to read and trade Tredio safely.
- [`apps/agent-market`](apps/agent-market): "attention check", a worker for the NEAR AI Agent Market that answers any topic with its attention index, the sources behind it and the NEAR AI review, paid per call (ready to list; a trial hire against a local stand-in of the market's API settled in testnet USDC).
- [`llms.txt`](landing-page/public/llms.txt) and the x402 endpoints in the API.

## Built with

- Contracts: Rust with [near-sdk](https://github.com/near/near-sdk-rs) 5 and near-contract-standards, built with cargo-near (SourceScan's reproducible image), tested on a local node with near-workspaces.
- NEAR: near-kit (transactions, gas keys, views), HOT's NEAR Connect for wallets, Chain Signatures (`v1.signer`), NEAR Intents 1Click and the Agent API SDK (`@near-intents-agent-api/sdk`), NEAR AI Cloud (`@nearai/inference-sdk`), OutLayer (the enclave oracle and custody wallets), and Rhea for coin pools.
- Services and API: Bun, Hono, Postgres (postgres.js), zod, pino and web-push; the MCP server uses `@modelcontextprotocol/sdk`; cryptography is `@noble/curves` and `@noble/hashes`.
- App and admin: Next.js and React, TanStack Query, zustand, framer-motion, lightweight-charts, vaul, sonner, NumberFlow and lucide icons; the website adds GSAP, Lenis and Swiper.
- Media: the launch film is made with Remotion, and the README figures with Pillow.
- Tests: bun test, Playwright and cargo test.
- Claude and OpenCode were used to write the code.

## Team

Emad Qureshi built Tredio.

## License

[MIT](LICENSE)
