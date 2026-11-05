-- Candidates whose trend faded (retired after cooling) leave the queue for good, as 'retired'.
-- Re-applied on every start: idempotent, and the constraint is only rebuilt while it lacks it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_status_check'
       AND pg_get_constraintdef(oid) LIKE '%''retired''%'
  ) THEN
    ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_status_check;
    ALTER TABLE candidates ADD CONSTRAINT candidates_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'live', 'retired'));
  END IF;
END
$$;
