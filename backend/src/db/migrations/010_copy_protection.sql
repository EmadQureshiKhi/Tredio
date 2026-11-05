-- Copy-trading protection. Re-applied on every start: idempotent.

-- The leader's average entry per market, so the price an increase added at (the leader's own fill)
-- bounds what a follower pays for the copy. Rows from before it stay NULL until the next snapshot.
ALTER TABLE leader_holdings ADD COLUMN IF NOT EXISTS entry_price DOUBLE PRECISION;

-- A follow whose open copies reached its loss cap is paused and closed out: the executor closes
-- every copy it still holds, retrying each tick, then clears this. Resuming or new caps clear it too.
ALTER TABLE follows ADD COLUMN IF NOT EXISTS closing_out BOOLEAN NOT NULL DEFAULT false;
