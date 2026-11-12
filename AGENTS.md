# Working on Tredio

Tredio is a NEAR-native attention market: an oracle in an OutLayer enclave scores trends from 0 to 100 on chain, and passkey accounts trade that index (Up/Down series, perps, trend coins, Hyperliquid perps through Chain Signatures).
This file is for AI agents and engineers working in the repository.
The product overview is in [README.md](README.md); the judges' checklist is in [JUDGES.md](JUDGES.md).

## Layout

- `contracts/`: Rust contracts (near-sdk 5, one Cargo workspace), deployed under `tredio.testnet`; account ids in `deployments/testnet.json`.
- `apps/`: Bun services, each with `/health`, `/live`, a `Dockerfile` and a `.env.example`: relayer (4100), keeper (4200), market-maker (4300), autopilot (4400), topup (4500), oracle (4600), indexer (4700), agent-market (4800: the attention check, live on the NEAR AI Agent Market as `@tredio`), activity (4900: the demo traders the team runs on testnet, disclosed in JUDGES.md).
- `backend/`: the Hono API on Postgres (4000): radar, NEAR AI review, sign-in, Autopilot, deposits, social, paid signals, status, x402.
- `frontend/` (the app, 3000), `admin/` (operator console), `landing-page/` (tredio.bid): Next.js.
- `packages/`: `chain` (sender, viewer, proofs, the x402 paying client), `contracts-ts` (`@tredio/contracts`: typed calls and deployments), `hyperliquid`, `intents` (1Click), `autopilot` (rule engine, copy-trading, sealed signals), `custody` (Autopilot's policy wallets: OutLayer custody on testnet, the NEAR Intents Agent API on mainnet), `mcp` (MCP server: read tools, and trade tools that send only within the user's policy, from a session key or an account's own key).
- `skills/tredio/SKILL.md`: the agent skill for using Tredio.
- `scripts/`: `dev.ts` (run everything), `verify.ts` (check the claims against testnet), `e2e-testnet.ts` (one full flow on testnet), `x402-demo.ts` (pay for an x402 route on testnet), `signals-demo.ts` (a paid signal on testnet), `policy-wallet.ts` (Autopilot on an OutLayer policy wallet on testnet), `gas-keys.ts`.
- `contracts/scripts/`: `build.sh` (local, or `--reproducible [commit]` in SourceScan's Docker image) and `deploy.sh testnet|mainnet`.
- [MAINNET.md](MAINNET.md): what changes on mainnet, the rehearsal and the deploy steps.

## Commands

```bash
pnpm install
pnpm test          # every package's tests
pnpm typecheck
pnpm lint
pnpm verify        # read testnet and check the claims in JUDGES.md
pnpm dev           # API, services and app against testnet
pnpm test:contracts
pnpm security      # NEAR rules, Clippy security lints, cargo deny and cargo audit
pnpm coverage:contracts
```

- Database tests (backend, Autopilot, indexer) need `TEST_DATABASE_URL`, a Postgres database they may truncate; without it `pnpm test` skips them with a notice (the backend refuses to skip under `CI`), and CI runs them on Postgres 16.
- CI (`.github/workflows/ci.yml`): typecheck, lint and every package's tests; contracts fmt, clippy and unit tests; the enclave crate's clippy and tests (it is not rustfmt-formatted); the sandbox crates run only locally.
- Contract sandbox flows: `cd contracts && cargo test -p tredio-sandbox-tests` (downloads a nearcore sandbox once); `--test mainnet` is the mainnet rehearsal, which imports Circle's USDC and Rhea from mainnet over RPC.
- Release wasm: `pnpm build:contracts` (`cargo near build`, to `target/near`); `contracts/scripts/build.sh --reproducible [commit]` builds a commit in Docker to `target/near-reproducible/<commit>`, which is what mainnet deploys and NearBlocks verifies.
- Live browser specs in `frontend/e2e` (`npx playwright test -c playwright.live.config.ts` against a running app) and `admin/e2e` run against testnet and spend testnet NEAR.

## How the pieces trust each other

- The `registry` accepts an index report only with an ed25519 signature from the oracle key in its state; that key is held by OutLayer and bound to the enclave build's sha256.
- A person's `0u...` account is owned by a passkey: `owner_execute` verifies a WebAuthn P-256 assertion over SHA-256("tredio-account:v1:" || request JSON) with `p256_verify`.
- Trading goes through `session_call` with a session key (a NEP-611 gas key on the account): typed actions only, a gross daily USDC cap on what moves USDC on NEAR, anchored prices, and the Hyperliquid guard (2% of a fresh mark, at most 10x; Hyperliquid actions move no USDC on NEAR, so the cap does not count them).
- The relayer pays for sign-ups (0.4 NEAR, with a backend activation ticket) and owner requests, after checking the passkey proof itself.
- API sign-in is NEP-413 (recipient `tredio.bid`) by a full-access key or an active session key, both read on chain; admin sign-in is NEP-413 with recipient `admin.tredio.bid` by an allowlisted account.

## Conventions

- Never hardcode a contract id: read it from `deployments/<network>.json` through `@tredio/contracts`.
- One switch: `NEAR_NETWORK` in every service, `NEXT_PUBLIC_NEAR_NETWORK` in the app and admin. `deployments/mainnet.json` is the plan (`status: "planned"`) until `deploy.sh mainnet` writes the live file; code that differs on mainnet carries a `#mainnet` comment.
- Units: USDC and outcome tokens 6 decimals, index 6 decimals (1e6 is one point), trend coins 18 decimals.
- Prose and docs: no em dash; in long Markdown, one sentence per line.
- Lines are long (about 160 columns) and code is not run through Prettier at its default width; match the file you are in.
- Every service exposes `/health` (detailed, with alerts) and `/live` (process up).
- Moderation hides calls and posts (`hidden_at`) and never deletes them: every public read of either table filters `hidden_at IS NULL`.
- Paid signals: the backend and the Autopilot executor share `SIGNALS_SECRET` (the weekly viewing keys derive from it); a follow whose leader is `signals:<identity>` copies a channel's signals and needs the follower's early access, which the API checks and a job pauses when it ends.
- Secrets live only in gitignored `.env` files; every app ships a `.env.example`.
- Run `pnpm verify` and the touched packages' tests before you call a change done.

## Working with the NEAR stack

Tredio is built around these NEAR behaviours; the code already handles each one, and new code should too.

- **Keys and reads.** NEAR keys are base58 and case-sensitive, so they are never lowercased. The app reads at `optimistic`, so a trade shows the moment it lands; `final` follows a block or two later.
- **Gas keys.** A gas key prepays the gas attached to each call in flight at 1e9 yocto a gas unit (300 Tgas reserves 0.3 NEAR), so the top-up service keeps every key funded; keys are refilled and revoked through the account, never deleted with a balance.
- **Account versions.** Accounts run account code v1, v2 or v3; `AccountVersions` from `@tredio/contracts` reads which one and what it supports (session gas, the Hyperliquid mark age, policy wallets). New accounts start on the newest code `deployments/<network>.json` names (`upgradeToLatest`), and earlier ones upgrade with one passkey prompt.
- **Outcomes.** Some contract refusals are logged events (`*_refused`, `*_rejected`) that return the funds, so callers read the receipts' logs as well as the status. Contract methods detach joint promises rather than return them.
- **RPC.** Every client fails over across providers, FastNEAR keys first (`FASTNEAR_API_KEYS` on servers, origin-locked `NEXT_PUBLIC_FASTNEAR_KEYS` in the app); a key a provider refuses rests ten minutes for the whole process, near-kit runs with `retryConfig: { maxRetries: 0 }` so the failover moves on at once, and recorded proofs are read from archival nodes (`archival-rpc.<network>.fastnear.com`), as `verify.ts` does.
- **Integrations.** 1Click makes confidential quotes with the partner JWT (`ONECLICK_JWT`) and public ones while it rests, and quotes need an existing mainnet recipient. OutLayer custody wallets act for an account through account code v3 (`acceptsWalletSessions`); a wallet's policy is stored before its API key is shared and is frozen, never deleted. Hyperliquid's leaderboard comes from mainnet, which testnet copies.
- **The oracle.** The registry trusts only the enclave's key, so reports come from the OutLayer build (`ORACLE_MODE=outlayer`); OutLayer caches the build by its wasm hash.
- **Releases.** Deployed contracts and published account code name the commit they were built from, so pushed history stays as it is; publishing global code costs 10 times the storage price (31.55 NEAR for the account code), so `deploy.sh` republishes it only with `PUBLISH_ACCOUNT_CODE=1`. Lint with `pnpm lint`.
