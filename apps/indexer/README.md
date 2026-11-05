# Tredio indexer

Reads the NEP-297 events of the Tredio contracts from FastNEAR's block stream (neardata) and writes them into Postgres tables the backend and app read.

## What it reads

- Blocks from `https://<network>.neardata.xyz/v0/block/<height>`, in height order, from `START_BLOCK` to the final head, then the head as it moves (neardata holds a request for the next height open until the block exists).
- Only successful receipts whose executor is Tredio's: the contracts in `deployments/<network>.json`, every trend coin (`*.coins.<root>`), and universal user accounts (`0u...`), of which only `tredio-account` events count.
- Every `EVENT_JSON:` log of those receipts: `tredio-registry`, `tredio-outcomes`, `tredio-book`, `tredio-perps`, `tredio-coins`, `tredio-curation`, `tredio-account`, `tredio-accounts`, NEP-245 (`mt_mint`, `mt_burn`, `mt_transfer`) from the outcomes contract and NEP-141 (`ft_mint`, `ft_burn`, `ft_transfer`) from USDC and the coins.
- Every request goes through one rate limiter (`NEARDATA_RPM`), and a 429 pauses them all.
  Without a key FastNEAR answers 429 past about 30 requests a minute per IP (measured on 2026-11-05; its docs say 180), so the default is 28.
  Testnet makes about 105 blocks a minute, so following the head needs a FastNEAR subscription key in `NEARDATA_API_KEY` (default rate 600 with a key).

The testnet start block, 276376358 (2026-11-05 18:11:14 UTC), is the block that created `usdc.tredio.testnet`, the first account of the deploy script; it was found with FastNEAR's transaction API (the oldest `tx_block_height` of each contract account).

## Tables

Everything lives in schema `indexer` (`INDEXER_SCHEMA`), created by idempotent migrations at start.
Amounts are raw integers in `numeric` (USDC, outcome tokens and the index have 6 decimals, coins 18), times are `timestamptz`.

- `events`: every stored event (block, time, receipt, transaction, executor, standard, event, `data` as jsonb, log index), and `cursor`: the last block processed.
- Registry: `trends`, `index_points` (every observation), `settlements`, `marks`, `oracle_runs`.
- Outcomes: `series` (with supplies and backing), `outcome_balances` (NEP-245 holdings), `outcome_flows` (USDC spent and received per account, series and side through mints, redemptions, swaps and fills, for average-cost PnL).
  Each flow row is one leg signed from the account's side (`tokens` and `usdc` positive when received); side `set` is a complete set of one UP and one DOWN per unit.
- Book: `book_markets`, `book_orders`, `book_trades`, `book_swaps`.
- Perps: `perp_positions`, `perp_funding`.
- Trend coins: `curves`, `coin_trades`, `coin_balances`.
- Curation: `curation`, `curation_claims`.
- Accounts: `accounts`, `sessions`, `session_actions`, `hyperliquid_signatures`.
- USDC: `usdc_transfers`, `usdc_mints`.

A block's events, their derived rows and the cursor commit in one transaction, and derived rows are written only for events stored for the first time, so re-processing a block after a crash adds nothing.
An event whose data does not match its known shape stays in `events` and is skipped with a warning; one whose handler keeps failing is skipped (and logged) after three attempts, so no event can hold the stream back.
One process at a time holds a schema (advisory lock).

## Commands

```sh
pnpm install                      # from the repo root
cp .env.example .env              # DATABASE_URL at least
bun run start                     # or `bun run dev` to restart on changes
bun run test                      # database tests need TEST_DATABASE_URL; INDEXER_LIVE=1 adds a live testnet check
bun run typecheck
docker build -f apps/indexer/Dockerfile .   # from the repo root
```

`GET /health` (port 4600) answers 200 while the indexed block is less than `MAX_LAG_SEC` old, with `height`, `head`, `lagBlocks`, `lagSec`, `eventsProcessed` and `startedAt`; `GET /live` answers 200 while the loop runs, whatever the lag.

## Resync

Stop the indexer first: a resync takes the same lock.

- `bun run resync` empties the derived tables and rebuilds them from `events`, without fetching anything (use it after changing a handler).
- `bun run resync --refetch` also clears `events` and the cursor, so the next start reads again from `START_BLOCK` (use it after changing which executors or events are kept).
- `bun run resync --from <height>` clears the events at and after `<height>`, rebuilds from the rest and moves the cursor back, so the next start reads again from `<height>`.

Refetching costs one request per block, so prefer a plain resync.
