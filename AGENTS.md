# Working on Tredio

Tredio is a NEAR-native attention market: an oracle in an OutLayer enclave scores trends from 0 to 100 on chain, and passkey accounts trade that index (Up/Down series, perps, trend coins, Hyperliquid perps through Chain Signatures).
This file is for AI agents and engineers working in the repository.
The product overview is in [README.md](README.md); the judges' checklist is in [JUDGES.md](JUDGES.md).

## Layout

- `contracts/`: Rust contracts (near-sdk 5, one Cargo workspace), deployed under `tredio.testnet`; account ids in `deployments/testnet.json`.
- `apps/`: Bun services, each with `/health`, `/live`, a `Dockerfile` and a `.env.example`: relayer (4100), keeper (4200), market-maker (4300), autopilot (4400), topup (4500), oracle (4600), indexer (4700), agent-market (4800: the attention check on the NEAR AI Agent Market, prepared and not listed).
- `backend/`: the Hono API on Postgres (4000): radar, NEAR AI review, sign-in, Autopilot, deposits, social, paid signals, status, x402.
- `frontend/` (the app, 3000), `admin/` (operator console), `landing-page/` (tredio.bid): Next.js.
- `packages/`: `chain` (sender, viewer, proofs, the x402 paying client), `contracts-ts` (`@tredio/contracts`: typed calls and deployments), `hyperliquid`, `intents` (1Click), `autopilot` (rule engine, copy-trading, sealed signals), `custody` (Autopilot's policy wallets: OutLayer custody on testnet, the NEAR Intents Agent API on mainnet), `mcp` (MCP server: read tools, and trade tools that send only within the user's policy, from a session key or an account's own key).
- `skills/tredio/SKILL.md`: the agent skill for using Tredio.
- `scripts/`: `dev.ts` (run everything), `verify.ts` (check the claims against testnet), `e2e-testnet.ts` (one full flow on testnet), `x402-demo.ts` (pay for an x402 route on testnet), `signals-demo.ts` (a paid signal on testnet), `policy-wallet.ts` (Autopilot on an OutLayer policy wallet on testnet), `gas-keys.ts`.
- `contracts/scripts/`: `build.sh` (local, or `--reproducible [commit]` in SourceScan's Docker image) and `deploy.sh testnet|mainnet`.
- [MAINNET.md](MAINNET.md): what changes on mainnet, the rehearsal and the deploy steps.
- `tools/make_readme_art.py`: the README figures (Pillow, colours from `frontend/app/globals.css`).

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
- Live browser specs in `frontend/e2e` and `admin/e2e` run against testnet and spend testnet NEAR; see `frontend/CLAUDE.md`.

## How the pieces trust each other

- The `registry` accepts an index report only with an ed25519 signature from the oracle key in its state; that key is held by OutLayer and bound to the enclave build's sha256.
- A person's `0u...` account is owned by a passkey: `owner_execute` verifies a WebAuthn P-256 assertion over SHA-256("tredio-account:v1:" || request JSON) with `p256_verify`.
- Trading goes through `session_call` with a session key (a NEP-611 gas key on the account): typed actions only, a gross daily USDC cap, anchored prices, and the Hyperliquid guard (2% of a fresh mark, at most 10x).
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

## Traps

- NEAR keys are base58 and case-sensitive: never lowercase a public or session key.
- RPC views at `final` lag a just-sent transaction by a block or two; the app reads `optimistic`.
- A gas key reserves the attached gas at 1e9 yocto per gas for every call in flight: 300 Tgas needs 0.3 NEAR in the key, and deleting a gas key burns its balance.
- Accounts run account code v1 (no `version` view), v2 or v3, and callers must not assume any: read it with `AccountVersions` from `@tredio/contracts`, which also gives the session call's gas (300 or 150 Tgas), the Hyperliquid mark age (120 or 300 s), whether the guard binds the mark's `asset_index`, whether renewals and revokes keep the gas key, and whether policy wallets can call (`acceptsWalletSessions`, v3).
  New accounts move onto the newest code `deployments/<network>.json` names (`globalCode.accountV2`, `accountV3`) in their first request (`upgradeToLatest`); v3 also requires the passkey's user-verification flag.
- Returning a joint promise (`a.and(b)`) from a contract method is not allowed; detach instead.
- Some contract refusals are logged events, not failures (`*_refused`, `*_rejected`): read the receipts' logs, not just the status.
- Public RPCs rate-limit per IP and answer a browser's 429 without CORS headers; keep polling modest and use the failover lists.
  Services, the indexer and the scripts take FastNEAR API keys in `FASTNEAR_API_KEYS` (comma-separated, one per request in turn, ahead of the public endpoints); the app takes origin-locked browser keys in `NEXT_PUBLIC_FASTNEAR_KEYS`.
  near-kit clients run with `retryConfig: { maxRetries: 0 }`, since its own retries wait up to 15 s on one provider before Tredio's failover moves on.
- 1Click quotes need an existing mainnet recipient, and confidential quotes need a partner JWT.
- OutLayer custody signs NEAR transactions only as the wallet's own implicit account, so a policy wallet acts for an account only through code that accepts its calls (`acceptsWalletSessions`, account code v3); store a wallet's policy before its API key goes anywhere (the first account to store it controls it), and never delete a policy (a wallet without one signs anything): freeze it.
- Hyperliquid testnet has no leaderboard; leaders come from mainnet's.
- Regular RPC nodes drop transactions after about five epochs (2.5 days): look recorded proofs up on an archival node (`archival-rpc.<network>.fastnear.com`), as `verify.ts` does.
- Publishing global code burns 10 times the storage price: 31.55 NEAR for the 316 KB account code. Re-running `deploy.sh` never republishes it; `PUBLISH_ACCOUNT_CODE=1` does, on purpose.
- A reproducible build records its commit, so never rewrite history past a deployed commit: NearBlocks and `pnpm verify` need that commit in the public repository.
- There is no Biome in this repo: `npx biome` runs an unrelated npm package. Lint with `pnpm lint`.
