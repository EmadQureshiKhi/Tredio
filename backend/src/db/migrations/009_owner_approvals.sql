-- Owner approvals: single-use nonces for actions that need a fresh passkey assertion (following,
-- enabling a rule, linking a caller identity). Re-applied on every start: idempotent.

CREATE TABLE IF NOT EXISTS owner_approvals (
  nonce         TEXT        PRIMARY KEY,
  account       TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  expires_at    BIGINT      NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_approvals_account ON owner_approvals (account, expires_at);
DELETE FROM owner_approvals WHERE expires_at < extract(epoch FROM now());
