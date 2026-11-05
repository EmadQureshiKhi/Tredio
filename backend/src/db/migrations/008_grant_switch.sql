-- Replacing an Autopilot grant. Re-applied on every start: idempotent.

-- A key requested while a grant is active waits here, sealed like session_key, and the active key
-- keeps trading. Once the account adds the new key on chain, it moves into session_key.
ALTER TABLE autopilot_grants ADD COLUMN IF NOT EXISTS next_session_key TEXT;
ALTER TABLE autopilot_grants ADD COLUMN IF NOT EXISTS next_sealed_key TEXT;
