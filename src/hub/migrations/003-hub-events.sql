CREATE TABLE IF NOT EXISTS org_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  kind            TEXT NOT NULL,
  board_id        TEXT REFERENCES boards(id) ON DELETE CASCADE,
  actor_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, seq)
);

-- Resume reads are always "this org, forward from seq".
CREATE INDEX IF NOT EXISTS org_events_stream_idx ON org_events (org_id, seq);

-- Replay protection for the daemon's offline queue: the same key may be POSTed
-- again after a reconnect and must not append a second event.
CREATE UNIQUE INDEX IF NOT EXISTS org_events_idempotency_idx
  ON org_events (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
