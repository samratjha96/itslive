-- Soft delete: adds 'deactivated' site status for the 7-day restore window.
-- Sites set to 'deactivated' are invisible to the serve worker and excluded
-- from plan-limit counts. The anti-entropy cron purges their R2 files and
-- transitions them to 'deleted_cooling' after cooling_until passes (7 days).
-- SQLite requires a table rebuild to modify CHECK constraints.

PRAGMA foreign_keys = OFF;

CREATE TABLE sites_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug_type       TEXT NOT NULL DEFAULT 'auto' CHECK (slug_type IN ('auto', 'custom')),
  type            TEXT NOT NULL DEFAULT 'static' CHECK (type IN ('static', 'dynamic')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted', 'deleted_cooling', 'deactivated')),
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

CREATE INDEX idx_sites_user_id     ON sites(user_id);
CREATE INDEX idx_sites_name        ON sites(name);
CREATE INDEX idx_sites_user_status ON sites(user_id, status);

PRAGMA foreign_keys = ON;
