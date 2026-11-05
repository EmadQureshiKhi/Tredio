-- Activation tickets the API signed: one row per account, counted against the sign-up caps per
-- client address and in total. Re-applied on every start: idempotent.

CREATE TABLE IF NOT EXISTS activation_tickets (
  account       TEXT        PRIMARY KEY,
  ip            TEXT        NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    BIGINT      NOT NULL
);
CREATE INDEX IF NOT EXISTS activation_tickets_issued ON activation_tickets (issued_at);
CREATE INDEX IF NOT EXISTS activation_tickets_ip ON activation_tickets (ip, issued_at);
DELETE FROM activation_tickets WHERE issued_at < now() - interval '30 days';
