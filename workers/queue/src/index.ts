import type { QueueMessage } from 'itslive-shared';
import { sendOtp, sendWelcome, sendExistingAccountNotice } from './email';

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITES: R2Bucket;
  RESEND_API_KEY: string;
}

export default {
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAntiEntropy(env));
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const body = msg.body as QueueMessage;
      try {
        switch (body.type) {
          case 'otp_email':
            await sendOtp(env.RESEND_API_KEY, body.email, body.code);
            break;
          case 'welcome_email':
            await sendWelcome(env.RESEND_API_KEY, body.email);
            break;
          case 'existing_account_notice':
            await sendExistingAccountNotice(env.RESEND_API_KEY, body.email);
            break;
          case 'site_delete_cleanup':
            await deleteSiteFiles(env, body.user_id, body.site_name);
            break;
          case 'deploy_cleanup':
            await deleteDeployFiles(env, body.site_id, body.deploy_id);
            break;
          default:
            // Unknown type — schema mismatch, retrying will never help
            console.error('Unknown queue message type, dropping:', (body as { type: string }).type);
            msg.ack();
            continue;
        }
        msg.ack();
      } catch (err) {
        console.error(`Queue job failed [${body.type}]:`, err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

// ── Anti-entropy cron ─────────────────────────────────────────────────────────
// Run steps sequentially to keep D1/R2/KV subrequest counts bounded and avoid
// overlapping R2 prefix deletes on the same site.

async function runAntiEntropy(env: Env): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ['reapDeactivatedSites', () => reapDeactivatedSites(env)],
    ['expireStuckDeploys', () => expireStuckDeploys(env)],
    ['cleanupOrphanedDeploys', () => cleanupOrphanedDeploys(env)],
    ['expireCoolingSites', () => expireCoolingSites(env)],
    ['cleanupBillingTables', () => cleanupBillingTables(env)],
  ];

  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.error(`[anti-entropy] ${name} failed:`, err);
    }
  }
}

// Delete sites that have passed their 30-day cooling window (and any legacy
// rows with status = 'deleted') once all of their R2 deploy prefixes have been
// purged, freeing UNIQUE(name) for reuse.
async function expireCoolingSites(env: Env): Promise<void> {
  const now = Date.now();
  const [, deleteRes] = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE sites SET active_deploy_id = NULL
         WHERE (status = 'deleted' OR (status = 'deleted_cooling' AND cooling_until <= ?))
           AND NOT EXISTS (SELECT 1 FROM deploys WHERE site_id = sites.id AND object_prefix IS NOT NULL)`
      )
      .bind(now),
    env.DB
      .prepare(
        `DELETE FROM sites
         WHERE (status = 'deleted' OR (status = 'deleted_cooling' AND cooling_until <= ?))
           AND NOT EXISTS (SELECT 1 FROM deploys WHERE site_id = sites.id AND object_prefix IS NOT NULL)`
      )
      .bind(now),
  ]);
  if (deleteRes.meta.changes > 0) {
    console.log(`[anti-entropy] purged ${deleteRes.meta.changes} expired cooling site(s)`);
  }
}

// Transition deactivated sites whose 7-day restore window has passed into the
// 30-day name-squatting cooling window FIRST (preventing a concurrent restore
// race), then purge their R2 files and clear deploy object prefixes. Also sweeps
// any deleted/deleted_cooling sites whose previous R2 cleanup failed mid-way.
async function reapDeactivatedSites(env: Env): Promise<void> {
  const now = Date.now();
  const rows = await env.DB
    .prepare(
      `SELECT id, user_id, name, status FROM sites
       WHERE (status = 'deactivated' AND cooling_until <= ?)
          OR (status IN ('deleted_cooling', 'deleted')
              AND EXISTS (SELECT 1 FROM deploys WHERE site_id = sites.id AND object_prefix IS NOT NULL))
       ORDER BY cooling_until ASC
       LIMIT 25`
    )
    .bind(now)
    .all<{ id: string; user_id: string; name: string; status: string }>();

  if (!rows.results?.length) return;

  const coolingUntil = now + 30 * 24 * 60 * 60 * 1000;
  let reaped = 0;
  for (const site of rows.results) {
    try {
      if (site.status === 'deactivated') {
        const claim = await env.DB
          .prepare(
            `UPDATE sites
             SET status = 'deleted_cooling', active_deploy_id = NULL, cooling_until = ?
             WHERE id = ? AND status = 'deactivated' AND cooling_until <= ?`
          )
          .bind(coolingUntil, site.id, now)
          .run();

        // If 0 rows changed, the user restored the site concurrently — do not touch R2.
        if (claim.meta.changes === 0) continue;
      }

      await env.KV.delete(`site:${site.name}`).catch(() => {});
      await deleteSiteFiles(env, site.user_id, site.name);
      await env.DB
        .prepare('UPDATE deploys SET object_prefix = NULL WHERE site_id = ?')
        .bind(site.id)
        .run();
      reaped++;
    } catch (err) {
      console.error(`[anti-entropy] failed to reap site ${site.id}:`, err);
    }
  }

  if (reaped > 0) {
    console.log(`[anti-entropy] reaped ${reaped} site(s) into cooling`);
  }
}

// Mark deploys that got stuck in 'uploading' for over an hour as failed so
// cleanupOrphanedDeploys purges any partial R2 objects they wrote.
async function expireStuckDeploys(env: Env): Promise<void> {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const result = await env.DB
    .prepare("UPDATE deploys SET status = 'failed' WHERE status = 'uploading' AND deployed_at <= ?")
    .bind(cutoff)
    .run();
  if (result.meta.changes > 0) {
    console.log(`[anti-entropy] expired ${result.meta.changes} stuck deploy(s)`);
  }
}

// Delete R2 objects for superseded or failed deploys on active/suspended/deactivated
// sites, then null out object_prefix so they are not re-scanned.
async function cleanupOrphanedDeploys(env: Env): Promise<void> {
  const rows = await env.DB
    .prepare(
      `SELECT id, site_id, object_prefix
       FROM deploys
       WHERE object_prefix IS NOT NULL
         AND status IN ('superseded', 'failed')
       ORDER BY deployed_at ASC
       LIMIT 25`
    )
    .all<{ id: string; site_id: string; object_prefix: string }>();

  if (!rows.results?.length) return;

  let cleaned = 0;
  for (const deploy of rows.results) {
    try {
      await deleteR2Prefix(env, deploy.object_prefix + '/');
      await env.DB
        .prepare('UPDATE deploys SET object_prefix = NULL WHERE id = ? AND site_id = ?')
        .bind(deploy.id, deploy.site_id)
        .run();
      cleaned++;
    } catch (err) {
      console.error(`[anti-entropy] failed to clean deploy ${deploy.id}:`, err);
    }
  }

  if (cleaned > 0) {
    console.log(`[anti-entropy] cleaned R2 for ${cleaned} orphaned deploy(s)`);
  }
}

// Prune expired checkout reservations and webhook idempotency records older
// than 30 days (Stripe retries webhooks for at most 72 hours).
async function cleanupBillingTables(env: Env): Promise<void> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const webhookCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM billing_checkouts WHERE expires_at <= ?').bind(nowSecs),
    env.DB.prepare('DELETE FROM stripe_webhook_events WHERE processed_at <= ?').bind(webhookCutoffMs),
  ]);
}

// ── R2 cleanup ────────────────────────────────────────────────────────────────

async function deleteSiteFiles(env: Env, userId: string, siteName: string): Promise<void> {
  if (!userId || !siteName) {
    throw new Error(`Cannot delete site files: userId=${userId} siteName=${siteName}`);
  }
  await deleteR2Prefix(env, `sites/${userId}/${siteName}/`);
}

async function deleteDeployFiles(env: Env, siteId: string, deployId: string): Promise<void> {
  if (!siteId || !deployId) {
    throw new Error(`Cannot delete deploy files: siteId=${siteId} deployId=${deployId}`);
  }

  const deploy = await env.DB
    .prepare('SELECT object_prefix FROM deploys WHERE id = ? AND site_id = ?')
    .bind(deployId, siteId)
    .first<{ object_prefix: string | null }>();

  if (!deploy?.object_prefix) {
    console.warn(`deploy_cleanup: no object_prefix for deploy ${deployId} on site ${siteId}`);
    return;
  }

  await deleteR2Prefix(env, deploy.object_prefix + '/');

  await env.DB
    .prepare('UPDATE deploys SET object_prefix = NULL WHERE id = ? AND site_id = ?')
    .bind(deployId, siteId)
    .run();
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await env.SITES.list({ prefix, limit: 1000, cursor });
    if (list.objects.length > 0) {
      await env.SITES.delete(list.objects.map(o => o.key));
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
