CREATE TABLE IF NOT EXISTS cards (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  board_id     TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  column_name  TEXT NOT NULL DEFAULT 'backlog',
  owner_agent  TEXT,
  paths        JSONB NOT NULL DEFAULT '[]'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (board_id, number)
);
CREATE INDEX IF NOT EXISTS cards_org_idx ON cards (org_id);

CREATE TABLE IF NOT EXISTS mail (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id     TEXT REFERENCES cards(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'ask',
  subject     TEXT,
  body        TEXT NOT NULL,
  from_agent  TEXT NOT NULL,
  to_agent    TEXT,
  to_human    BOOLEAN NOT NULL DEFAULT false,
  reply_to    TEXT REFERENCES mail(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mail_org_board_idx ON mail (org_id, board_id);
CREATE INDEX IF NOT EXISTS mail_inbox_idx ON mail (org_id, to_agent) WHERE delivered_at IS NULL;

-- Presence is latest-state-only. It is deliberately NOT in the event log:
-- heartbeats must not inflate the replayable history.
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  device_id       TEXT REFERENCES devices(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('working', 'idle', 'waiting', 'offline')),
  current_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
  activity        TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, board_id, name)
);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents (org_id);
