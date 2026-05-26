-- Plan enforcement: adds 'suspended' site status and supporting indices
-- Run: npx wrangler d1 execute itslive-prod --file=migrations/0003_plan_enforcement.sql --remote
--
-- SQLite does not support ALTER TABLE to modify CHECK constraints, so we
-- rebuild the sites table. Foreign keys are temporarily disabled for the swap.

PRAGMA foreign_keys = OFF;

CREATE TABLE sites_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug_type       TEXT NOT NULL DEFAULT 'auto' CHECK (slug_type IN ('auto', 'custom')),
  type            TEXT NOT NULL DEFAULT 'static' CHECK (type IN ('static', 'dynamic')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted', 'deleted_cooling')),
  cooling_until   INTEGER,
  created_at      INTEGER NOT NULL,
  deployed_at     INTEGER,
  worker_id       TEXT,
  db_id           TEXT,
  password_hash   TEXT,
  session_ttl_hrs INTEGER NOT NULL DEFAULT 24,
  active_deploy_id TEXT REFERENCES deploys(id),
  UNIQUE(name)
);

INSERT INTO sites_new SELECT * FROM sites;
DROP TABLE sites;
ALTER TABLE sites_new RENAME TO sites;

CREATE INDEX idx_sites_user_id    ON sites(user_id);
CREATE INDEX idx_sites_name       ON sites(name);
CREATE INDEX idx_sites_user_status ON sites(user_id, status);

PRAGMA foreign_keys = ON;
