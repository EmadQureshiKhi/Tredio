-- Session tokens signed out before they expire (admin and app). Rows past expiry can be dropped.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_hash    TEXT        PRIMARY KEY,
  expires_at    BIGINT      NOT NULL,
  revoked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
DELETE FROM revoked_tokens WHERE expires_at < extract(epoch FROM now());
