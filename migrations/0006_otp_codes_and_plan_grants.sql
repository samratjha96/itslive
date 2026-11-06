-- OTP codes move from KV to D1 so the per-code attempt counter can be
-- incremented atomically before the code is compared.
CREATE TABLE otp_codes (
  email_hash TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

-- Plan reconciliation derives Pro entitlement only from billing_purchases.
-- Record a grant for every Pro user who has no valid purchase row (legacy
-- builder/studio plans migrated in 0005, manual comps), so a refund or dispute
-- on some other payment cannot downgrade them.
INSERT INTO billing_purchases (payment_intent_id, user_id, paid, refunded, dispute_status, updated_at)
SELECT 'grant:' || u.id, u.id, 1, 0, 'none', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users u
WHERE u.plan = 'pro'
  AND NOT EXISTS (
    SELECT 1 FROM billing_purchases p
    WHERE p.user_id = u.id AND p.paid = 1 AND p.refunded = 0 AND p.dispute_status IN ('none', 'won')
  );

-- Concurrent deploys could previously leave a deploy marked 'active' that its
-- site no longer points to, so cleanup never purged its files. Mark existing
-- orphans superseded so the anti-entropy cron reclaims their R2 objects.
UPDATE deploys SET status = 'superseded'
WHERE status = 'active'
  AND id NOT IN (SELECT active_deploy_id FROM sites WHERE active_deploy_id IS NOT NULL);
