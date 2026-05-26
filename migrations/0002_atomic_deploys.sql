-- Atomic deploy model: sites track their active deploy, deploys track lifecycle status
-- Run: npx wrangler d1 execute itslive-prod --file=migrations/0002_atomic_deploys.sql --remote

ALTER TABLE sites ADD COLUMN active_deploy_id TEXT REFERENCES deploys(id);

ALTER TABLE deploys ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE deploys ADD COLUMN object_prefix TEXT;
ALTER TABLE deploys ADD COLUMN manifest_json TEXT;

CREATE INDEX idx_deploys_site_status ON deploys(site_id, status);
