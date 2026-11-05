-- Verified NEAR AI Cloud reviews: the evidence of each verified completion (signature, signer,
-- model), keyed by its SHA-256, which the registry stores with a listing. Re-applied on every
-- start: idempotent.
CREATE TABLE IF NOT EXISTS ai_reviews (
  review_hash   TEXT        PRIMARY KEY CHECK (review_hash ~ '^[0-9a-f]{64}$'),
  model         TEXT        NOT NULL,
  completion_id TEXT        NOT NULL,
  evidence      JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS review_hash TEXT REFERENCES ai_reviews (review_hash);
