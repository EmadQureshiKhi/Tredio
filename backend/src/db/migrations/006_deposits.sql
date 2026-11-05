-- Any-chain deposits and withdrawals through NEAR Intents 1Click: one row per live quote (deposit
-- address), with the swap's state as 1Click reports it (packages/intents). Never moves backwards.
CREATE TABLE IF NOT EXISTS deposits (
  id              BIGSERIAL   PRIMARY KEY,
  account         TEXT        NOT NULL,
  deposit_address TEXT        NOT NULL,
  deposit_memo    TEXT,
  state           JSONB       NOT NULL,
  phase           TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deposit_address, deposit_memo)
);
CREATE INDEX IF NOT EXISTS deposits_account ON deposits (account, created_at DESC);
