-- The admin system view asks for each source's newest reading and its readings in the last hour:
-- an index by source and time answers both without scanning every measurement.
-- Re-applied on every start: idempotent.
CREATE INDEX IF NOT EXISTS measurements_source_time ON measurements (source, observed_at DESC);
