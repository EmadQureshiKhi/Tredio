-- Tredio indexer schema. Runs on every start inside the configured schema (search_path), so
-- every statement is idempotent. Amounts are raw integers (USDC, outcome tokens and the index
-- carry 6 decimals, trend coins 18, perp quantities and cumulative funding 18) kept as numeric;
-- times are timestamptz from the event's own unix seconds, or the block time.

-- Raw NEP-297 events of successful receipts of Tredio executors. Derived tables are rebuilt
-- from these alone (`bun run resync`).
create table if not exists events (
  block_height bigint not null,
  block_time timestamptz not null,
  idx integer not null,
  receipt_id text not null,
  tx_hash text,
  executor text not null,
  standard text not null,
  version text not null,
  event text not null,
  data jsonb not null,
  log_index integer not null,
  primary key (receipt_id, log_index)
);
create index if not exists events_order on events (block_height, idx);
create index if not exists events_kind on events (standard, event, block_height);
create index if not exists events_executor on events (executor, block_height);

-- Last block fully processed, one row per network.
create table if not exists cursor (
  id text primary key,
  height bigint not null,
  block_time timestamptz,
  updated_at timestamptz not null default now()
);

-- Registry ----------------------------------------------------------------------------------

create table if not exists trends (
  id text primary key,
  asset_class text not null,
  status text not null check (status in ('active', 'cooling', 'retired')),
  index numeric not null,
  peak_index numeric not null,
  surfacer text,
  review_hash text,
  asset text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status_since timestamptz not null
);
create index if not exists trends_status on trends (status, updated_at desc);

-- Every observation, including the first (the registry keeps only the last 96 on chain).
create table if not exists index_points (
  trend text not null,
  at timestamptz not null,
  index numeric not null,
  clamped boolean not null default false,
  primary key (trend, at)
);

-- Settlement values per trend and series expiry; a missed one has no value.
create table if not exists settlements (
  trend text not null,
  expiry timestamptz not null,
  value numeric,
  missed boolean not null default false,
  first_observation timestamptz,
  at timestamptz not null,
  primary key (trend, expiry)
);

-- Latest Hyperliquid mark per asset (8 decimals).
create table if not exists marks (
  asset text primary key,
  price numeric not null,
  at timestamptz not null
);

create table if not exists oracle_runs (
  run_id bigint primary key,
  observed_at timestamptz not null,
  created integer not null,
  updated integer not null,
  marks integer not null,
  rejected integer not null,
  block_height bigint not null,
  receipt_id text not null
);

-- Outcomes ----------------------------------------------------------------------------------

create table if not exists series (
  id bigint primary key,
  trend text not null,
  window_sec integer not null,
  number integer not null,
  opened_at timestamptz not null,
  expiry timestamptz not null,
  opening_index numeric not null,
  outcome text not null default 'open' check (outcome in ('open', 'up', 'down', 'void')),
  settlement_index numeric,
  settled_at timestamptz,
  up_supply numeric not null default 0,
  down_supply numeric not null default 0,
  -- USDC the outcomes contract holds for the series.
  backing numeric not null default 0
);
create index if not exists series_trend on series (trend, window_sec, number desc);
create index if not exists series_open on series (expiry) where outcome = 'open';

-- NEP-245 holdings; a balance that reaches zero is removed.
create table if not exists outcome_balances (
  account text not null,
  series bigint not null,
  side text not null check (side in ('up', 'down')),
  balance numeric not null,
  updated_at timestamptz not null,
  primary key (account, series, side)
);
create index if not exists outcome_balances_series on outcome_balances (series, side);

-- USDC spent and received per account and series, one row per leg: tokens and usdc are signed
-- from the account's side (+ received, - given). side 'set' is a complete set (one UP and one
-- DOWN per unit). kinds: mint, redeem, winnings, payout_failed (reverses a payout), swap, fill.
create table if not exists outcome_flows (
  receipt_id text not null,
  log_index integer not null,
  leg smallint not null,
  account text not null,
  series bigint not null,
  side text not null check (side in ('up', 'down', 'set')),
  kind text not null,
  tokens numeric not null,
  usdc numeric not null,
  fee numeric not null default 0,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index, leg)
);
create index if not exists outcome_flows_account on outcome_flows (account, series, block_height);

-- Book --------------------------------------------------------------------------------------

create table if not exists book_markets (
  series bigint not null,
  side text not null check (side in ('up', 'down')),
  trend text not null,
  expiry timestamptz not null,
  last_tick integer,
  volume_usdc numeric not null default 0,
  trades integer not null default 0,
  listed_at timestamptz not null,
  primary key (series, side)
);

create table if not exists book_orders (
  id bigint primary key,
  owner text not null,
  series bigint not null,
  side text not null check (side in ('up', 'down')),
  dir text not null check (dir in ('buy', 'sell')),
  tick integer not null,
  -- Size that rested (after any immediate fills) and what is left of it.
  size numeric not null,
  remaining numeric not null,
  status text not null check (status in ('open', 'filled', 'cancelled')),
  placed_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists book_orders_owner on book_orders (owner, status);
create index if not exists book_orders_market on book_orders (series, side, status);

create table if not exists book_trades (
  receipt_id text not null,
  log_index integer not null,
  series bigint not null,
  side text not null,
  maker_order bigint not null,
  maker text not null,
  taker text not null,
  taker_dir text not null,
  tick integer not null,
  size numeric not null,
  usdc numeric not null,
  fee numeric not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists book_trades_market on book_trades (series, side, block_height);
create index if not exists book_trades_maker on book_trades (maker, block_height);
create index if not exists book_trades_taker on book_trades (taker, block_height);

create table if not exists book_swaps (
  receipt_id text not null,
  log_index integer not null,
  account text not null,
  series bigint not null,
  side text not null,
  dir text not null,
  anchored boolean not null,
  fair numeric,
  amount_in numeric not null,
  amount_out numeric not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists book_swaps_account on book_swaps (account, block_height);

-- Perps -------------------------------------------------------------------------------------

create table if not exists perp_positions (
  id bigint primary key,
  owner text not null,
  payer text not null,
  trend text not null,
  is_long boolean not null,
  qty numeric not null,
  margin numeric not null,
  entry_index numeric not null,
  fee_open numeric not null,
  opened_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed', 'liquidated', 'settled')),
  exit_index numeric,
  pnl numeric,
  funding numeric,
  fee_close numeric,
  payout numeric,
  -- Liquidations: who liquidated, their reward and the equity left at the time.
  liquidator text,
  reward numeric,
  equity numeric,
  -- What the pool could not pay the winner (socialized loss).
  shortfall numeric,
  closed_at timestamptz,
  close_receipt text
);
create index if not exists perp_positions_owner on perp_positions (owner, status);
create index if not exists perp_positions_trend on perp_positions (trend, status);

create table if not exists perp_funding (
  trend text not null,
  at timestamptz not null,
  cum_long numeric not null,
  cum_short numeric not null,
  mark numeric not null,
  primary key (trend, at)
);

-- Trend coins -------------------------------------------------------------------------------

create table if not exists curves (
  trend text primary key,
  coin text not null,
  stage text not null check (stage in ('open', 'ready', 'pooled', 'graduated')),
  virtual_quote numeric not null,
  reserve numeric not null default 0,
  sold numeric not null default 0,
  -- USDC (6 decimals) per whole coin, scaled by 1e18.
  spot numeric not null,
  peak_at_creation numeric not null,
  pool_id bigint,
  created_at timestamptz not null,
  graduated_at timestamptz
);
create unique index if not exists curves_coin on curves (coin);

create table if not exists coin_trades (
  receipt_id text not null,
  log_index integer not null,
  trend text not null,
  trader text not null,
  is_buy boolean not null,
  usdc numeric not null,
  coins numeric not null,
  fee numeric not null,
  reserve numeric not null,
  sold numeric not null,
  spot numeric not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists coin_trades_trend on coin_trades (trend, block_height);
create index if not exists coin_trades_trader on coin_trades (trader, block_height);

-- NEP-141 holdings of every trend coin; a balance that reaches zero is removed.
create table if not exists coin_balances (
  coin text not null,
  account text not null,
  balance numeric not null,
  updated_at timestamptz not null,
  primary key (coin, account)
);
create index if not exists coin_balances_account on coin_balances (account);

-- Curation ----------------------------------------------------------------------------------

create table if not exists curation (
  receipt_id text not null,
  log_index integer not null,
  trend text not null,
  surfacer text not null,
  source text not null,
  amount numeric not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists curation_surfacer on curation (surfacer, block_height);
create index if not exists curation_trend on curation (trend);

create table if not exists curation_claims (
  receipt_id text not null,
  log_index integer not null,
  account text not null,
  amount numeric not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists curation_claims_account on curation_claims (account);

-- Accounts ----------------------------------------------------------------------------------

-- User accounts: created by the factory (owner_key, funded in yoctoNEAR, created_at) or first
-- seen through their own events (a first session is added before the factory logs the creation).
create table if not exists accounts (
  account text primary key,
  owner_key text,
  funded numeric,
  created_at timestamptz,
  frozen boolean not null default false,
  code_hash text,
  first_seen timestamptz not null
);

create table if not exists sessions (
  account text not null,
  public_key text not null,
  label text not null,
  scope jsonb not null,
  expires_at timestamptz not null,
  daily_limit numeric not null,
  gas_key boolean not null,
  added_at timestamptz not null,
  revoked_at timestamptz,
  primary key (account, public_key)
);

create table if not exists session_actions (
  receipt_id text not null,
  log_index integer not null,
  account text not null,
  public_key text not null,
  action text not null,
  outflow numeric not null,
  spent_today numeric not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists session_actions_account on session_actions (account, block_height);

create table if not exists hyperliquid_signatures (
  receipt_id text not null,
  log_index integer not null,
  account text not null,
  digest text not null,
  kind text not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists hyperliquid_signatures_account on hyperliquid_signatures (account, block_height);

-- USDC --------------------------------------------------------------------------------------

-- One row per entry of an ft_transfer event (n is its position in the event's array).
create table if not exists usdc_transfers (
  receipt_id text not null,
  log_index integer not null,
  n smallint not null,
  old_owner text not null,
  new_owner text not null,
  amount numeric not null,
  memo text,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index, n)
);
create index if not exists usdc_transfers_old on usdc_transfers (old_owner, block_height);
create index if not exists usdc_transfers_new on usdc_transfers (new_owner, block_height);

create table if not exists usdc_mints (
  receipt_id text not null,
  log_index integer not null,
  n smallint not null,
  owner text not null,
  amount numeric not null,
  memo text,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index, n)
);
create index if not exists usdc_mints_owner on usdc_mints (owner, block_height);
