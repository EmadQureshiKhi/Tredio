-- Moderation hides a call or post instead of deleting it: the signed row stays where it was, with
-- the replies and posts that point at it, and an admin can restore it as it was. Every public view
-- (threads, profiles, the leaderboard, share links, call notifications) skips hidden rows, and the
-- log records each hide and restore. Older log rows keep 'remove_call' and 'remove_post' from when
-- moderation deleted. Re-applied on every start: idempotent.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'moderation_log'::regclass AND conname = 'moderation_log_action_check'
       AND pg_get_constraintdef(oid) LIKE '%''restore_post''%'
  ) THEN
    ALTER TABLE moderation_log DROP CONSTRAINT IF EXISTS moderation_log_action_check;
    ALTER TABLE moderation_log ADD CONSTRAINT moderation_log_action_check
      CHECK (action IN ('rename_caller', 'remove_call', 'remove_post', 'hide_call', 'hide_post', 'restore_call', 'restore_post'));
  END IF;
END
$$;
