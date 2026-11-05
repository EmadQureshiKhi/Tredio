-- Moderation: what an admin changed in the social layer, and the content as it stood before. A
-- removed call or post leaves the public views, and its signed original stays here.

CREATE TABLE IF NOT EXISTS moderation_log (
  id             BIGSERIAL   PRIMARY KEY,
  admin          TEXT        NOT NULL,
  action         TEXT        NOT NULL CHECK (action IN ('rename_caller', 'remove_call', 'remove_post')),
  target         TEXT        NOT NULL,
  reason         TEXT        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  before         JSONB       NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_log_target ON moderation_log (target, created_at DESC);
