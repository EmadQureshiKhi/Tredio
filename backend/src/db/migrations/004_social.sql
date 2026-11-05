-- Social layer: callers (passkey-derived identity keys, unlinkable to trading accounts unless
-- linked by both keys), public calls with verifiable outcomes, per-trend threads, the sealed vault,
-- and web-push subscriptions.

CREATE TABLE IF NOT EXISTS callers (
  address        TEXT        PRIMARY KEY,
  handle         TEXT        UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  bio            TEXT        CHECK (char_length(bio) <= 160),
  linked_account TEXT,
  linked_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS callers_linked_account ON callers (linked_account) WHERE linked_account IS NOT NULL;

-- A call: the caller's signed view that a trend's attention ends a window above (up) or below
-- (down) where it stood when called. Resolved from the registry's own checkpoints.
CREATE TABLE IF NOT EXISTS calls (
  id             BIGSERIAL        PRIMARY KEY,
  caller         TEXT             NOT NULL REFERENCES callers(address),
  identifier     TEXT             NOT NULL,
  trend_id       TEXT             NOT NULL,
  direction      TEXT             NOT NULL CHECK (direction IN ('up', 'down')),
  horizon_sec    INTEGER          NOT NULL CHECK (horizon_sec IN (86400, 604800)),
  note           TEXT             CHECK (char_length(note) <= 280),
  signature      TEXT             NOT NULL UNIQUE,
  called_at      BIGINT           NOT NULL,
  opening_index  DOUBLE PRECISION NOT NULL,
  resolves_at    BIGINT           NOT NULL,
  closing_index  DOUBLE PRECISION,
  outcome        TEXT             NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'hit', 'miss', 'void')),
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_caller ON calls (caller, called_at DESC);
CREATE INDEX IF NOT EXISTS calls_identifier ON calls (identifier, called_at DESC);
CREATE INDEX IF NOT EXISTS calls_due ON calls (resolves_at) WHERE outcome = 'open';

CREATE TABLE IF NOT EXISTS posts (
  id             BIGSERIAL   PRIMARY KEY,
  caller         TEXT        NOT NULL REFERENCES callers(address),
  identifier     TEXT        NOT NULL,
  body           TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  reply_to       BIGINT      REFERENCES posts(id) ON DELETE SET NULL,
  call_id        BIGINT      REFERENCES calls(id) ON DELETE SET NULL,
  signature      TEXT        NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_thread ON posts (identifier, created_at DESC);

-- Private data sealed on the device with the passkey's vault key; the server sees ciphertext only.
CREATE TABLE IF NOT EXISTS vault_items (
  owner          TEXT        NOT NULL,
  kind           TEXT        NOT NULL CHECK (kind IN ('strategy', 'note')),
  item_id        TEXT        NOT NULL CHECK (item_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  ciphertext     TEXT        NOT NULL CHECK (char_length(ciphertext) <= 65536),
  iv             TEXT        NOT NULL,
  version        INTEGER     NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, kind, item_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint       TEXT        PRIMARY KEY,
  account        TEXT        NOT NULL,
  p256dh         TEXT        NOT NULL,
  auth           TEXT        NOT NULL,
  topics         TEXT[]      NOT NULL DEFAULT '{autopilot,copy,calls,markets}',
  failures       INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_account ON push_subscriptions (account);

-- Where the notification dispatcher has read up to in each event stream.
CREATE TABLE IF NOT EXISTS cursors (
  name           TEXT        PRIMARY KEY,
  position       BIGINT      NOT NULL DEFAULT 0
);
