-- The Mainnet waitlist: people who asked to hear when Tredio launches on Mainnet and to join its
-- beta, from the app or the website. Collected only: nobody is emailed before the launch. The
-- client address is kept as a salted hash, never raw. Re-applied on every start: idempotent.

CREATE TABLE IF NOT EXISTS waitlist (
  id               BIGSERIAL   PRIMARY KEY,
  email            TEXT        NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
  source           TEXT        NOT NULL CHECK (source IN ('app', 'landing')),
  account          TEXT        CHECK (account ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$' AND length(account) BETWEEN 2 AND 64),
  consent          BOOLEAN     NOT NULL CHECK (consent),
  ip_hash          TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_at       TIMESTAMPTZ,
  unsubscribed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS waitlist_created ON waitlist (created_at DESC, id DESC);
