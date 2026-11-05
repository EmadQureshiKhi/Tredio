-- Rotation: when every live slot is taken, a faded trend makes room for a stronger approved
-- candidate. The backend picks it; the oracle stops updating it, and the registry retires it
-- as stale. One rotation runs at a time.
CREATE TABLE IF NOT EXISTS rotations (
  id            BIGSERIAL PRIMARY KEY,
  identifier    TEXT        NOT NULL,
  base          TEXT        NOT NULL,
  trend_id      TEXT        NOT NULL,
  replacement   TEXT,
  reason        TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'rotating' CHECK (status IN ('rotating', 'done', 'cancelled')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS rotations_one_active ON rotations ((true)) WHERE status = 'rotating';
CREATE INDEX IF NOT EXISTS rotations_base ON rotations (base, started_at DESC);

-- Trends an admin keeps live: rotation never picks them. Keyed by the base identifier, so a pin
-- holds across relistings.
CREATE TABLE IF NOT EXISTS trend_pins (
  identifier    TEXT        PRIMARY KEY,
  pinned_by     TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accounts that asked to hear when an approved candidate lists ("Notify me when it lists").
CREATE TABLE IF NOT EXISTS candidate_watches (
  candidate_id  BIGINT      NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  account       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at   TIMESTAMPTZ,
  PRIMARY KEY (candidate_id, account)
);
CREATE INDEX IF NOT EXISTS candidate_watches_pending ON candidate_watches (candidate_id) WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS candidate_watches_account ON candidate_watches (account);
