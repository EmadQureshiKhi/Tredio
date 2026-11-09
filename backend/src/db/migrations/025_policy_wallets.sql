-- Autopilot grants backed by a policy wallet. Re-applied on every start: idempotent.

-- The session of such a grant is for the wallet's own key, and its sealed box holds the wallet's
-- credential (an OutLayer API key, or an Agent API grant token) instead of a session key. Keyed by
-- the session key, so a waiting key keeps its wallet when it takes over the grant.
CREATE TABLE IF NOT EXISTS autopilot_grant_wallets (
  session_key  TEXT        PRIMARY KEY,
  owner        TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN ('outlayer', 'agent-api')),
  -- The wallet's NEAR account (an implicit account): it sends the session calls and pays their gas.
  account      TEXT        NOT NULL,
  -- The Agent API agent (mainnet); null for OutLayer custody.
  agent_id     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_grant_wallets_owner ON autopilot_grant_wallets (owner);
