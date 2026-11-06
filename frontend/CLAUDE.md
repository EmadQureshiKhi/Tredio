# Tredio app (frontend)

Next.js 16 + React 19 app for Tredio's attention markets on NEAR (testnet today).
It talks to three things directly from the browser: NEAR RPC (reads and gas key sends), the Tredio API (`NEXT_PUBLIC_API_URL`) and the relayer (`NEXT_PUBLIC_RELAYER_URL`).
Contracts come from `deployments/<network>.json` through `@tredio/contracts`; never hardcode contract ids.

## Commands

- `npm run lint`, `npm test` (bun tests in `test/`), `npm run build`.
- Check a production build without touching `.next`: `NEXT_DIST_DIR=.next-check npm run build && NEXT_DIST_DIR=.next-check npx next start -p 3010`.
- Live end-to-end specs (real testnet, each run creates a passkey account and costs the relayer testnet NEAR): `npx playwright test -c playwright.live.config.ts` against a running app.

## Architecture

- `src/lib/chain/`: JSON-RPC with failover, cooldowns and shared in-flight reads (`client.ts`), ed25519 keys and NEP-413 (`keys.ts`), outcome parsing incl. logged refusals (`outcome.ts`), gas key sending with 4 nonce lanes (`sender.ts`).
- `src/lib/account/`: passkey accounts (WebAuthn P-256 + PRF), the session gas key sealed in IndexedDB, relayer calls, NEAR Connect wallets, and `AccountProvider` (the React face of it all).
- `src/lib/trade/`: call builders (`calls.ts`), contract math mirrored from the contracts (`math.ts`), reads (`reads.ts`), and `useTx` (every send goes through `useTx().run(send, { action, done })`, which owns the toast).
- `src/features/*`: one folder per screen.

## Conventions and traps

- Passkey accounts trade through `session_call` with the session key (no prompt); limit orders, coin trades, withdrawals and session changes are owner actions the passkey signs and the relayer submits.
- Wallet accounts sign every call themselves and cannot do passkey-only things (Hyperliquid, Autopilot, copy, calls); screens explain that rather than hide it.
- Some contract refusals are logged events, not failures (`*_refused`): always check `refusalOf(outcome)`.
- Animations use `m.*` from `framer-motion` under the lazy `LazyMotion`; changing numbers use `<Num>`; toasts go through `notify`.
- React Query keys have one shape per key (for example `["book", series, side, levels]`); trades invalidate what they change, so polling can stay slow.
- Public RPCs rate-limit per IP: keep polling intervals modest and never add a burst of parallel views.
- Brand files (`src/components/shell/Logo.tsx`, `app/fonts*`, icons, OG images) are final; do not edit them.
