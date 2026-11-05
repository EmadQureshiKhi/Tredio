-- Tredio radar, collector and app data. Re-applied on every start, so every statement is idempotent.

-- Proposed trends, from Elfa trending tokens and narratives, pasted links and seeds.
CREATE TABLE IF NOT EXISTS candidates (
  id            BIGSERIAL PRIMARY KEY,
  identifier    TEXT        NOT NULL UNIQUE,
  display_name  TEXT        NOT NULL,
  asset_class   SMALLINT    NOT NULL,
  keywords      TEXT[]      NOT NULL DEFAULT '{}',
  article       TEXT,
  ticker        TEXT,
  summary       TEXT,
  source        TEXT        NOT NULL CHECK (source IN ('elfa_trending', 'elfa_narrative', 'wikipedia_top', 'link', 'seed', 'manual')),
  source_ref    JSONB       NOT NULL DEFAULT '{}',
  surfacer      TEXT        NOT NULL DEFAULT 'radar',
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'live')),
  confidence    REAL        NOT NULL DEFAULT 0,
  ai            JSONB       NOT NULL DEFAULT '{}',
  decided_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidates_status ON candidates (status, updated_at DESC);

-- What the app shows for a trend beyond its on-chain state.
CREATE TABLE IF NOT EXISTS trend_meta (
  identifier    TEXT        PRIMARY KEY,
  trend_id      TEXT        NOT NULL UNIQUE,
  display_name  TEXT        NOT NULL,
  summary       TEXT,
  keywords      TEXT[]      NOT NULL DEFAULT '{}',
  article       TEXT,
  ticker        TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw source measurements the oracle reads and the app charts.
CREATE TABLE IF NOT EXISTS measurements (
  id            BIGSERIAL PRIMARY KEY,
  identifier    TEXT             NOT NULL,
  source        TEXT             NOT NULL CHECK (source IN ('elfa', 'gdelt', 'nansen', 'wikipedia')),
  metric        TEXT             NOT NULL,
  value         DOUBLE PRECISION NOT NULL,
  window_sec    INTEGER          NOT NULL,
  observed_at   TIMESTAMPTZ      NOT NULL,
  created_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS measurements_latest ON measurements (identifier, source, observed_at DESC);

-- Credits spent per API key per UTC day, so budgets hold across restarts. Keys are stored by
-- fingerprint, never in full.
CREATE TABLE IF NOT EXISTS api_usage (
  provider      TEXT    NOT NULL,
  key_id        TEXT    NOT NULL,
  day           DATE    NOT NULL,
  credits       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_id, day)
);

-- Links people paste to propose a trend.
CREATE TABLE IF NOT EXISTS link_requests (
  id            BIGSERIAL PRIMARY KEY,
  url           TEXT        NOT NULL,
  submitter     TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'proposed', 'rejected', 'failed')),
  candidate_id  BIGINT      REFERENCES candidates(id) ON DELETE SET NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_requests_submitter ON link_requests (submitter, created_at DESC);

-- Signals the radar has assessed (a token, a narrative, a Wikipedia article), so each costs one
-- AI call until it is due for another look.
CREATE TABLE IF NOT EXISTS radar_signals (
  key           TEXT        PRIMARY KEY,
  kind          TEXT        NOT NULL,
  identifier    TEXT,
  assessed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Loop runs, for health and the status view.
CREATE TABLE IF NOT EXISTS job_runs (
  job           TEXT        PRIMARY KEY,
  last_ok_at    TIMESTAMPTZ,
  last_error    TEXT,
  last_error_at TIMESTAMPTZ,
  last_report   JSONB       NOT NULL DEFAULT '{}'
);
