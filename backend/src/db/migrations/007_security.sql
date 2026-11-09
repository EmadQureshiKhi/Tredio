-- Security hardening. Re-applied on every start: idempotent.

-- Every session key the backend generated for an Autopilot grant, replaced ones included. These
-- keys belong to the executor, never to the account, so they may not sign in to the API.
CREATE TABLE IF NOT EXISTS autopilot_grant_keys (
  session_key   TEXT        PRIMARY KEY,
  owner         TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO autopilot_grant_keys (session_key, owner) SELECT session_key, owner FROM autopilot_grants ON CONFLICT DO NOTHING;

-- Pasted links always wait for a reviewer. Send back to review any link the radar approved on its
-- own before that rule; reviewers' approvals carry their address, so they stay as they are.
UPDATE candidates SET status = 'pending', decided_by = NULL, updated_at = now()
 WHERE source = 'link' AND status = 'approved' AND decided_by = 'radar';
