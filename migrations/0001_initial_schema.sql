-- ItsLive initial schema
-- Run: npx wrangler d1 execute itslive-prod --file=migrations/0001_initial_schema.sql --remote

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'builder', 'studio')),
  created_at  INTEGER NOT NULL,
  verified_at INTEGER,
  stripe_id   TEXT
);

CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash    TEXT UNIQUE NOT NULL,
  prefix      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  rotated_at  INTEGER,
  last_used   INTEGER
);

-- site name is globally unique (subdomain uniqueness enforced at DB level)
CREATE TABLE sites (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug_type       TEXT NOT NULL DEFAULT 'auto' CHECK (slug_type IN ('auto', 'custom')),
  type            TEXT NOT NULL DEFAULT 'static' CHECK (type IN ('static', 'dynamic')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'deleted_cooling')),
  cooling_until   INTEGER,
  created_at      INTEGER NOT NULL,
  deployed_at     INTEGER,
  worker_id       TEXT,
  db_id           TEXT,
  password_hash   TEXT,
  session_ttl_hrs INTEGER NOT NULL DEFAULT 24,
  UNIQUE(name)
);

CREATE TABLE deploys (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  deployed_at INTEGER NOT NULL,
  size_bytes  INTEGER NOT NULL,
  file_count  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  agent_ua    TEXT
);

CREATE INDEX idx_sites_user_id ON sites(user_id);
CREATE INDEX idx_sites_name ON sites(name);
CREATE INDEX idx_deploys_site_id ON deploys(site_id);
CREATE INDEX idx_deploys_deployed_at ON deploys(site_id, deployed_at DESC);
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
