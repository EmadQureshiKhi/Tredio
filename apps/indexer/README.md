# Tredio indexer

Reads the NEP-297 events of the Tredio contracts from FastNEAR's free APIs and writes them into Postgres tables the backend and app read.

## What it reads

- Only successful receipts whose executor is Tredio's: the contracts in `deployments/<network>.json`, every trend coin (`*.coins.<root>`), and universal user accounts (`0u...`), of which only `tredio-account` events count.
- Every `EVENT_JSON:` log of those receipts: `tredio-registry`, `tredio-outcomes`, `tredio-book`, `tredio-perps`, `tredio-coins`, `tredio-curation`, `tredio-account`, `tredio-accounts`, NEP-245 (`mt_mint`, `mt_burn`, `mt_transfer`) from the outcomes contract and NEP-141 (`ft_mint`, `ft_burn`, `ft_transfer`) from USDC and the coins.
- From `START_BLOCK` on.
  The testnet default, 276376358 (2026-11-05 18:11:14 UTC), is the block that created `usdc.tredio.testnet`, the first account of the deploy script (the oldest `tx_block_height` of each contract account in FastNEAR's transactions API).

Two feeds give the same rows (`INDEXER_SOURCE`):

- `txs` (default): FastNEAR's transactions API (`https://tx.test.fastnear.com`, `https://tx.main.fastnear.com`), which lists the transactions that touched an account.
  Each cycle reads the API's committed head, lists every transaction that touched a core account (the deployment's contracts and `RELAYER_ACCOUNT_ID`) up to `TX_SAFETY_BLOCKS` below it, fetches the new ones 20 at a time, and commits their events block by block before moving the cursor there.
  A transaction still running is fetched again each cycle until it ends; listings start `TX_LOOKBACK_BLOCKS` below the cursor, so a restart repeats nothing that matters.
  Trend coins and user accounts are listed too, a few per cycle in turn (`TX_SLOW_PER_CYCLE`): they catch the actions that touch no core account (user-to-user coin transfers, Hyperliquid leverage signatures, owner requests relayed by someone else), whose events may arrive after the cursor passed them and only feed tables that do not depend on the order of other accounts' events.
  Without a key the API answers 429 past about 60 requests a minute per IP (measured on 2026-11-06), so the default rate is 55 and a cycle (about a dozen requests) takes about 14 s: the cursor follows testnet 10 to 40 s behind.
  Backfilling from the start block took 19 requests.
- `blocks`: every block from neardata (`https://<network>.neardata.xyz`).
  Without a key it answers 429 past about 30 requests a minute per IP (measured on 2026-11-05; its docs say 180), slower than testnet's 105 blocks a minute, so this feed needs a FastNEAR subscription key in `NEARDATA_API_KEY`.

Both share one rate limiter per API (`TX_API_RPM`, `NEARDATA_RPM`); a 429 pauses every request, and a key (`TX_API_KEY`, `NEARDATA_API_KEY`) is sent as a bearer token.

## Tables

Everything lives in schema `indexer` (`INDEXER_SCHEMA`), created by idempotent migrations at start.
Amounts are raw integers in `numeric` (USDC, outcome tokens and the index have 6 decimals, coins 18), times are `timestamptz`.

- `events`: every stored event (block, time, receipt, transaction, executor, standard, event, `data` as jsonb, log index, and `idx`, its order in the block), and `cursor`: the last block processed.
- Registry: `trends`, `index_points` (every observation), `settlements`, `marks` (with the Hyperliquid `asset_index` each mark vouches for, once the oracle reports it), `oracle_runs`.
- Outcomes: `series` (with supplies and backing), `outcome_balances` (NEP-245 holdings), `outcome_flows` (USDC spent and received per account, series and side through mints, redemptions, swaps and fills, for average-cost PnL).
  Each flow row is one leg signed from the account's side (`tokens` and `usdc` positive when received); side `set` is a complete set of one UP and one DOWN per unit.
- Book: `book_markets`, `book_orders`, `book_trades`, `book_swaps`.
- Perps: `perp_positions`, `perp_funding`.
- Trend coins: `curves`, `coin_trades`, `coin_balances`.
- Curation: `curation`, `curation_claims`.
- Accounts: `accounts`, `sessions`, `session_actions`, `hyperliquid_signatures`, `gas_top_ups`, and `creation_refunds` (deposits of failed creations the factory returned or keeps claimable).
  A session's `key_state` says what became of its key: `active`, `dormant` (account v2 keeps a revoked gas key, unable to act), `deleted`, or `failed` (never added, so the account dropped the session); a v2 renewal updates the row in place and keeps `added_at`.
- USDC: `usdc_transfers`, `usdc_mints`.

A block's events, their derived rows and the cursor commit in one transaction, and derived rows are written only for events stored for the first time, so re-processing a block after a crash adds nothing.
An event whose data does not match its known shape stays in `events` and is skipped with a warning; one whose handler keeps failing is skipped (and logged) after three attempts, so no event can hold the stream back.
One process at a time holds a schema (advisory lock).

## Commands

```sh
pnpm install                      # from the repo root
cp .env.example .env              # DATABASE_URL at least
bun run start                     # or `bun run dev` to restart on changes
bun run test                      # database tests need TEST_DATABASE_URL; INDEXER_LIVE=1 adds live testnet checks
bun run typecheck
docker build -f apps/indexer/Dockerfile .   # from the repo root
```

`GET /health` (port 4700) answers 200 while the indexed block is less than `MAX_LAG_SEC` old, with `height`, `head`, `lagBlocks`, `lagSec`, `eventsProcessed` and `startedAt`; `GET /live` answers 200 while the loop runs, whatever the lag.

## Resync

Stop the indexer first: a resync takes the same lock.

- `bun run resync` empties the derived tables and rebuilds them from `events`, without fetching anything (use it after changing a handler).
- `bun run resync --refetch` also clears `events` and the cursor, so the next start reads again from `START_BLOCK` (use it after changing which executors or events are kept).
- `bun run resync --from <height>` clears the events at and after `<height>`, rebuilds from the rest and moves the cursor back, so the next start reads again from `<height>`.
