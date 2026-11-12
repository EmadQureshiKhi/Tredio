# Demo traders (testnet)

Twelve invented personas the team runs on NEAR testnet, so Tredio's screens show a working market: they trade, call and post on a schedule through `ACTIVITY_UNTIL`.
None of them is a real person, and JUDGES.md says so.

## What they do

- Each persona has a passkey account made the way the app makes one (`scripts/activity-setup.ts`), a 16-day gas-key session, test USDC from the faucet, and a caller identity with a handle and bio.
- About `ACTIONS_PER_DAY` times a day, spread over each persona's waking hours (08:00 to midnight in its own time zone), one persona acts: Up/Down buys and sells, attention perps opened and closed (held an hour at least), winnings collected from settled series, calls (at most three a day, one per trend), and thread posts, some answering another persona's open call.
- Its style (`src/personas.ts`) sets what it favors: momentum sides with the day's move, contrarian fades it, perps traders mostly open perps, callers mostly call and post, swing traders mix.
- Every trade is a real `session_call` on testnet from the persona's own session key; calls and posts are signed by its caller key, as the app signs them.
- The funder `activity.tredio-treasury.testnet` (topped up by the top-up service) refills a session gas key below `GAS_KEY_MIN_NEAR` and adds storage deposits when a contract asks for them.
- A buy or sell with nothing on the book to fill it is skipped, not sent.

## Run it

```bash
bun scripts/activity-setup.ts            # once: the funder and the personas (internal/keys/, gitignored)
cd apps/activity && bun run start        # with .env from .env.example
```

On the server it is the `activity` service in `deploy/docker-compose.yml`, with the personas file mounted read-only.
`GET /health` reports the actions by kind, failures, the last ten actions and the funder's balance; `GET /live` answers while the process runs.
