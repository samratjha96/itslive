-- Collapse paid tiers ('builder', 'studio') into a single 'pro' plan, index stripe_id,
-- and track Stripe checkout attempts, purchases, and webhook events for idempotent, replay-safe fulfillment.
-- SQLite requires a table rebuild to modify CHECK constraints.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_new (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  created_at  INTEGER NOT NULL,
  verified_at INTEGER,
  stripe_id   TEXT
);

INSERT INTO users_new (id, email, plan, created_at, verified_at, stripe_id)
SELECT
  id,
  email,
  CASE WHEN plan IN ('builder', 'studio', 'pro') THEN 'pro' ELSE 'free' END,
  created_at,
  verified_at,
  stripe_id
FROM users;

CREATE TABLE api_keys_saved AS SELECT * FROM api_keys;
CREATE TABLE sites_saved AS SELECT * FROM sites;
CREATE TABLE deploys_saved AS SELECT * FROM deploys;

UPDATE sites SET active_deploy_id = NULL;
DELETE FROM deploys;
DELETE FROM sites;
DELETE FROM api_keys;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

INSERT INTO api_keys SELECT * FROM api_keys_saved;
INSERT INTO sites (id, user_id, name, slug_type, type, status, cooling_until, created_at, deployed_at, worker_id, db_id, password_hash, session_ttl_hrs, active_deploy_id)
SELECT id, user_id, name, slug_type, type, status, cooling_until, created_at, deployed_at, worker_id, db_id, password_hash, session_ttl_hrs, NULL FROM sites_saved;
INSERT INTO deploys SELECT * FROM deploys_saved;
UPDATE sites SET active_deploy_id = (SELECT active_deploy_id FROM sites_saved WHERE sites_saved.id = sites.id);

DROP TABLE deploys_saved;
DROP TABLE sites_saved;
DROP TABLE api_keys_saved;

CREATE INDEX idx_users_stripe_id ON users(stripe_id);

CREATE TABLE billing_checkouts (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  attempt_id   TEXT NOT NULL,
  session_id   TEXT,
  checkout_url TEXT,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE billing_purchases (
  payment_intent_id TEXT PRIMARY KEY,
  user_id           TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_id        TEXT,
  customer_id       TEXT,
  paid              INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  refunded          INTEGER NOT NULL DEFAULT 0 CHECK (refunded IN (0, 1)),
  dispute_status    TEXT NOT NULL DEFAULT 'none' CHECK (dispute_status IN ('none', 'open', 'won', 'lost')),
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_billing_purchases_user_id ON billing_purchases(user_id);

CREATE TABLE stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

PRAGMA defer_foreign_keys = OFF;
