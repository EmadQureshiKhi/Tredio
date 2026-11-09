# Tredio admin panel

Internal panel for the Tredio backend.
Reviewers approve or reject the trend candidates the radar and pasted links propose, edit what the AI suggested before a trend goes live, and watch backend health and the background jobs.
Built with Next.js 16 (App Router), TanStack Query and Tailwind CSS 4.

## How access works

The browser talks to the backend directly; this app has no server routes of its own.
The backend checks every admin request against its `ADMIN_ADDRESSES`.

1. The reviewer signs one sign-in request for `POST /v1/admin/session` with an allowlisted admin account, binding the method, path, a timestamp, a random nonce and the body hash.
2. The backend answers with a 12 hour bearer token, which the panel keeps in memory and in `sessionStorage`, so a reload in the same tab does not ask for a new signature.
   Later requests send that token; signed admin requests (not bearer tokens) are limited to 60 per 10 minutes per IP.
3. Any `401` ends the session and returns to the sign-in screen with the reason.

`NEXT_PUBLIC_ADMIN_WALLETS` is only a hint on the sign-in screen; it grants nothing.
Signing out revokes the token on the backend (`POST /v1/admin/session/revoke`) and then forgets it here, even when the backend cannot be reached.

## Screens

- `/system` (the landing page): the whole system at a glance from `/v1/admin/system`, with what is wrong ranked first: every service's health, the oracle, each Elfa key with its credits and last calls, the data sources and AI providers, the background jobs and recent errors.
  It refreshes every 20 seconds and spends no Elfa credits; "Check keys now" asks Elfa for every key's status (one credit per key, after a confirmation, at most once a minute).
- `/candidates`: candidates by status (pending, approved, rejected, live, retired, all), with the AI's reason, policy flags, confidence, source and surfacer.
  Review opens a form for the identifier, display name, keywords, Wikipedia article and summary, checked with the backend's own rules; only changed fields are sent.
- `/rotation`: the live board, with the rotation rules, the running rotation, recent ones and each live trend, where a trend can be pinned.
- `/moderation`: thread posts and calls, newest first, filtered by caller and by whether they are hidden; callers with what they published; and the log of every moderation action with its reason.
  Hiding a post or call takes it out of every public view (threads, profiles, the leaderboard, share links) without deleting it, and restoring brings it back as it was; an admin may also replace a caller's handle and bio.
  Every action asks for a reason.
- `/operations`: the admin health report from `/v1/admin/health` (database, oracle, Elfa and Nansen budgets, AI providers, GDELT, jobs), buttons that run the radar, collector or history job now and follow the run to its end, and the live trends.
- `/waitlist`: the Mainnet waitlist, with search, invites, CSV export and deletion.

## Setup

```bash
npm ci
cp .env.example .env.local
```

- `NEXT_PUBLIC_BACKEND_URL`: the backend origin (default `http://localhost:4000`).
  The backend's `FRONTEND_URL` must list this panel's origin for CORS.
- `NEXT_PUBLIC_ADMIN_WALLETS`: optional comma-separated admin accounts for the sign-in hint.

`NEXT_PUBLIC_` values are inlined at build time.
In production the panel is served from https://admin.tredio.bid and talks to https://api.tredio.bid.

## Commands

The frontend uses port 3000, so the panel runs on 3001.

```bash
npm run dev         # http://localhost:3001
npm run lint
npm run typecheck
npm run build
npm run start       # serves the build on 3001
npm run test:e2e    # Playwright, against the local backend
```

## End-to-end tests

`npm run test:e2e` drives the panel in Chromium against the real backend on port 4000 (start it first with `cd backend && bun run dev`), using a dev server already on 3001 or starting one.
The tests sign in with a local admin key, which must be in the backend's `ADMIN_ADDRESSES`.
The key stays in the test process and is never printed.
Run `npx playwright install chromium` once.

The tests change real candidate rows and put them back: they only re-decide rejected or approved candidates that are not live, never a pending one (the API cannot set a row back to pending), and keep any approval to the moment it takes to check it.
The API cannot restore `decidedBy` and `updatedAt`, so those two fields show the test run afterwards.
The moderation test makes its own caller identity (an `e2e_mod_` handle), posts and calls on a live trend as the app would, and leaves both hidden, so nothing it wrote stays public; that caller and its log entries remain.
The tests need an admin key and a running backend, so CI runs lint, typecheck and build only.
