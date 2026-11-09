-- Paid private trade signals (backend/src/signals, packages/autopilot/src/signals.ts). A leader is a
-- caller identity linked to an account; signals are stored sealed under the week's viewing key and
-- revealed to everyone after the leader's delay. Re-applied on every start: idempotent.
CREATE TABLE IF NOT EXISTS signal_channels (
  leader           TEXT        PRIMARY KEY,
  -- USDC (atomic, 6 decimals) for one period of early access.
  price_usdc       BIGINT      NOT NULL CHECK (price_usdc > 0),
  period_days      INT         NOT NULL CHECK (period_days BETWEEN 1 AND 90),
  reveal_delay_sec INT         NOT NULL CHECK (reveal_delay_sec BETWEEN 300 AND 604800),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signals (
  id           BIGSERIAL   PRIMARY KEY,
  leader       TEXT        NOT NULL REFERENCES signal_channels (leader),
  -- SHA-256 of the signed message, committed on chain in a USDC transfer memo from the leader's account.
  commitment   TEXT        NOT NULL UNIQUE,
  signature    TEXT        NOT NULL,
  epoch        INT         NOT NULL,
  iv           TEXT        NOT NULL,
  ciphertext   TEXT        NOT NULL,
  issued_at    BIGINT      NOT NULL,
  committed_at BIGINT      NOT NULL,
  commit_tx    TEXT        NOT NULL UNIQUE,
  reveal_at    BIGINT      NOT NULL,
  hidden_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_leader ON signals (leader, issued_at DESC);

-- Early access bought in USDC on NEAR, by a transfer to the leader's account the API verified.
CREATE TABLE IF NOT EXISTS signal_access (
  id         BIGSERIAL   PRIMARY KEY,
  buyer      TEXT        NOT NULL,
  leader     TEXT        NOT NULL REFERENCES signal_channels (leader),
  starts_at  BIGINT      NOT NULL,
  expires_at BIGINT      NOT NULL,
  amount     BIGINT      NOT NULL,
  payment_tx TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signal_access_buyer ON signal_access (buyer, leader, expires_at DESC);

-- Admins hide and restore signals as they do calls and posts (src/social/moderation.ts).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'moderation_log'::regclass AND conname = 'moderation_log_action_check'
       AND pg_get_constraintdef(oid) LIKE '%''restore_signal''%'
  ) THEN
    ALTER TABLE moderation_log DROP CONSTRAINT IF EXISTS moderation_log_action_check;
    ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_action_check
      CHECK (action IN ('rename_caller', 'remove_call', 'remove_post', 'hide_call', 'hide_post', 'restore_call', 'restore_post', 'hide_signal', 'restore_signal'));
  END IF;
END
$$;
