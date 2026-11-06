# Working on Tredio

Tredio is a NEAR-native attention market: an oracle in an OutLayer enclave scores trends from 0 to 100 on chain, and passkey accounts trade that index (Up/Down series, perps, trend coins, Hyperliquid perps through Chain Signatures).
This file is for AI agents and engineers working in the repository.
The product overview is in [README.md](README.md); the judges' checklist is in [JUDGES.md](JUDGES.md).

## Layout

- `contracts/`: Rust contracts (near-sdk 5, one Cargo workspace), deployed under `tredio.testnet`; account ids in `deployments/testnet.json`.
- `apps/`: Bun services, each with `/health`, `/live`, a `Dockerfile` and a `.env.example`: relayer (4100), keeper (4200), market-maker (4300), autopilot (4400), topup (4500), oracle (4600), indexer (4700).
- `backend/`: the Hono API on Postgres (4000): radar, NEAR AI review, sign-in, Autopilot, deposits, social, status, x402.
- `frontend/` (the app, 3000), `admin/` (operator console), `landing-page/` (tredio.bid): Next.js.
- `packages/`: `chain` (sender, viewer, proofs, the x402 paying client), `contracts-ts` (`@tredio/contracts`: typed calls and deployments), `hyperliquid`, `intents` (1Click), `autopilot` (rule engine), `mcp` (MCP server).
- `skills/tredio/SKILL.md`: the agent skill for using Tredio.
- `scripts/`: `dev.ts` (run everything), `verify.ts` (check the claims against testnet), `e2e-testnet.ts` (one full flow on testnet), `x402-demo.ts` (pay for an x402 route on testnet), `gas-keys.ts`.
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
```

- Database tests (backend, Autopilot, indexer) need `TEST_DATABASE_URL`, a Postgres database they may truncate; without it `pnpm test` skips them with a notice (the backend refuses to skip under `CI`), and CI runs them on Postgres 16.
- CI (`.github/workflows/ci.yml`): typecheck, lint and every package's tests; contracts fmt, clippy and unit tests; the enclave crate's clippy and tests (it is not rustfmt-formatted); the sandbox crates run only locally.
- Contract sandbox flows: `cd contracts && cargo test -p tredio-sandbox-tests` (downloads a nearcore sandbox once).
- Release wasm: `pnpm build:contracts` (`cargo near build`).
- Live browser specs in `frontend/e2e` and `admin/e2e` run against testnet and spend testnet NEAR; see `frontend/CLAUDE.md`.

## How the pieces trust each other

- The `registry` accepts an index report only with an ed25519 signature from the oracle key in its state; that key is held by OutLayer and bound to the enclave build's sha256.
- A person's `0u...` account is owned by a passkey: `owner_execute` verifies a WebAuthn P-256 assertion over SHA-256("tredio-account:v1:" || request JSON) with `p256_verify`.
- Trading goes through `session_call` with a session key (a NEP-611 gas key on the account): typed actions only, a gross daily USDC cap, anchored prices, and the Hyperliquid guard (2% of a fresh mark, at most 10x).
- The relayer pays for sign-ups (0.4 NEAR, with a backend activation ticket) and owner requests, after checking the passkey proof itself.
- API sign-in is NEP-413 (recipient `tredio.bid`) by a full-access key or an active session key, both read on chain; admin sign-in is NEP-413 with recipient `admin.tredio.bid` by an allowlisted account.

## Conventions

- Never hardcode a contract id: read it from `deployments/<network>.json` through `@tredio/contracts`.
- Units: USDC and outcome tokens 6 decimals, index 6 decimals (1e6 is one point), trend coins 18 decimals.
- Prose and docs: no em dash; in long Markdown, one sentence per line.
- Lines are long (about 160 columns) and code is not run through Prettier at its default width; match the file you are in.
- Every service exposes `/health` (detailed, with alerts) and `/live` (process up).
- Secrets live only in gitignored `.env` files; every app ships a `.env.example`.
- Run `pnpm verify` and the touched packages' tests before you call a change done.

## Traps

- NEAR keys are base58 and case-sensitive: never lowercase a public or session key.
- RPC views at `final` lag a just-sent transaction by a block or two; the app reads `optimistic`.
- A gas key reserves the attached gas at 1e9 yocto per gas for every call in flight: 300 Tgas needs 0.3 NEAR in the key, and deleting a gas key burns its balance.
- Accounts run account code v1 (no `version` view) or v2, and callers must not assume either: read it with `AccountVersions` from `@tredio/contracts`, which also gives the session call's gas (300 or 150 Tgas), the Hyperliquid mark age (120 or 300 s), whether the guard binds the mark's `asset_index`, and whether renewals and revokes keep the gas key.
  New accounts upgrade to v2 in their first request only once `deployments/<network>.json` names `globalCode.accountV2`.
- Returning a joint promise (`a.and(b)`) from a contract method is not allowed; detach instead.
- Some contract refusals are logged events, not failures (`*_refused`, `*_rejected`): read the receipts' logs, not just the status.
- Public RPCs rate-limit per IP and answer a browser's 429 without CORS headers; keep polling modest and use the failover lists.
- 1Click quotes need an existing mainnet recipient, and confidential quotes need a partner JWT.
- Hyperliquid testnet has no leaderboard; leaders come from mainnet's.
