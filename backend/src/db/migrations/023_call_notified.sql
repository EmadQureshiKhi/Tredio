-- A resolved call notifies its caller once, marked on the call itself. A cursor over call ids
-- missed calls, since calls resolve out of id order (a 24 h call made after a 7 d one resolves
-- first). Calls already resolved when the column arrives count as notified, so nothing old buzzes.
-- Re-applied on every start: idempotent, and the backfill runs only when the column is added.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'calls'::regclass AND attname = 'notified_at' AND NOT attisdropped) THEN
    ALTER TABLE calls ADD COLUMN notified_at TIMESTAMPTZ;
    UPDATE calls SET notified_at = now() WHERE outcome <> 'open';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS calls_unnotified ON calls (id) WHERE outcome <> 'open' AND notified_at IS NULL;
