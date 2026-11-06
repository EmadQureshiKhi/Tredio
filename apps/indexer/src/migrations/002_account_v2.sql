-- Account code v2 and the registry's Hyperliquid asset indexes. Idempotent, like 001.

-- The Hyperliquid asset index each ticker's marks vouch for (registry v2's `asset_index_set`).
alter table marks add column if not exists asset_index integer;

-- What became of a session's key: `active` (on the account; the session may have expired),
-- `dormant` (v2: its session was revoked, the gas key kept, unable to act), `deleted`, or
-- `failed` (it could not be added, so the account dropped the session).
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'sessions' and column_name = 'key_state') then
    alter table sessions add column key_state text not null default 'active';
    -- Before v2 a revoke always deleted the key.
    update sessions set key_state = 'deleted' where revoked_at is not null;
  end if;
end $$;

-- NEAR sessions moved from their account into their own gas key (v2 `top_up_gas`).
create table if not exists gas_top_ups (
  receipt_id text not null,
  log_index integer not null,
  account text not null,
  public_key text not null,
  amount numeric not null,
  today numeric not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
create index if not exists gas_top_ups_account on gas_top_ups (account, block_height);

-- Deposits of failed account creations the factory sent back, or keeps for `claim_refund`.
create table if not exists creation_refunds (
  receipt_id text not null,
  log_index integer not null,
  account text not null,
  payer text not null,
  amount numeric not null,
  claimable boolean not null,
  at timestamptz not null,
  block_height bigint not null,
  primary key (receipt_id, log_index)
);
