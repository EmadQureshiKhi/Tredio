-- Free attention sources: Bluesky trends, CoinGecko and GeckoTerminal trending lists propose
-- candidates, and Bluesky and Hacker News mentions are new collector readings.
-- Re-applied on every start: idempotent, and each constraint is only rebuilt while it lacks them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_source_check'
       AND pg_get_constraintdef(oid) LIKE '%''geckoterminal_trending''%'
  ) THEN
    ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_source_check;
    ALTER TABLE candidates ADD CONSTRAINT candidates_source_check
      CHECK (source IN ('elfa_trending', 'elfa_narrative', 'wikipedia_top', 'bluesky_trend', 'coingecko_trending', 'geckoterminal_trending', 'link', 'seed', 'manual'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'measurements'::regclass AND conname = 'measurements_source_check'
       AND pg_get_constraintdef(oid) LIKE '%''hn''%'
  ) THEN
    ALTER TABLE measurements DROP CONSTRAINT IF EXISTS measurements_source_check;
    ALTER TABLE measurements ADD CONSTRAINT measurements_source_check
      CHECK (source IN ('elfa', 'gdelt', 'nansen', 'wikipedia', 'bluesky', 'hn'));
  END IF;
END
$$;
