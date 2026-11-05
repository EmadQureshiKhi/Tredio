-- Attention alerts: an account asks to hear when a topic's attention index rises or drops by a
-- percentage within a window, or crosses a level. Re-applied on every start: idempotent.
CREATE TABLE IF NOT EXISTS attention_alerts (
  id            BIGSERIAL   PRIMARY KEY,
  account       TEXT        NOT NULL,
  -- The topic's base identifier: an alert follows the topic across listings.
  base          TEXT        NOT NULL,
  kind          TEXT        NOT NULL CHECK (kind IN ('rise', 'drop', 'above', 'below')),
  change_pct    REAL        CHECK (change_pct IS NULL OR (change_pct > 0 AND change_pct <= 1000)),
  window_min    INT         CHECK (window_min IS NULL OR (window_min >= 5 AND window_min <= 10080)),
  level         REAL        CHECK (level IS NULL OR (level > 0 AND level < 100)),
  -- A crossing alert fires once per crossing: it re-arms when the index is back on the near side.
  armed         BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fired_at TIMESTAMPTZ,
  fired_count   INT         NOT NULL DEFAULT 0,
  CHECK ((kind IN ('rise', 'drop') AND change_pct IS NOT NULL AND window_min IS NOT NULL) OR (kind IN ('above', 'below') AND level IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS attention_alerts_account ON attention_alerts (account);
CREATE INDEX IF NOT EXISTS attention_alerts_base ON attention_alerts (base);

-- The "alerts" push topic: on by default, and turned on once for every device that already
-- receives notifications (a marker keeps a later "off" from being undone on the next start).
ALTER TABLE push_subscriptions ALTER COLUMN topics SET DEFAULT '{autopilot,copy,calls,markets,alerts}';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cursors WHERE name = 'migrated:alerts-topic') THEN
    UPDATE push_subscriptions SET topics = array_append(topics, 'alerts') WHERE NOT ('alerts' = ANY (topics));
    INSERT INTO cursors (name, position) VALUES ('migrated:alerts-topic', 1);
  END IF;
END $$;
