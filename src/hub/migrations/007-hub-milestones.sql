-- Shared milestones: the "one major milestone with areas of work" an org rallies
-- around. Mirrors the local daemon's milestones table minus local-only ordering
-- (roadmap rank, step_order stay per-machine).
CREATE TABLE IF NOT EXISTS milestones (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'shipped', 'dropped')),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS milestones_org_board ON milestones (org_id, board_id);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;
