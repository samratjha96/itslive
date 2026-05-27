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
          case 'post_deploy_cache_purge':
            await env.KV.delete(`site:${body.site_name}`);
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

async function runAntiEntropy(env: Env): Promise<void> {
  await Promise.allSettled([
    expireCoolingSites(env),
    reapDeactivatedSites(env),
    cleanupSupersededDeploys(env),
    expireStuckDeploys(env),
  ]);
}

// Flip sites that have passed their cooling window to 'deleted'.
async function expireCoolingSites(env: Env): Promise<void> {
  const now = Date.now();
  const result = await env.DB
    .prepare("UPDATE sites SET status = 'deleted' WHERE status = 'deleted_cooling' AND cooling_until <= ?")
    .bind(now)
    .run();
  if (result.meta.changes > 0) {
    console.log(`[anti-entropy] expired ${result.meta.changes} cooling site(s)`);
  }
}

// Purge R2 files for deactivated sites whose 7-day restore window has passed,
// then transition them into the 30-day name-squatting cooling window.
async function reapDeactivatedSites(env: Env): Promise<void> {
  const now = Date.now();
  const rows = await env.DB
    .prepare("SELECT id, user_id, name FROM sites WHERE status = 'deactivated' AND cooling_until <= ? LIMIT 50")
    .bind(now)
    .all<{ id: string; user_id: string; name: string }>();

  if (!rows.results?.length) return;

  const coolingUntil = now + 30 * 24 * 60 * 60 * 1000;
  let reaped = 0;
  for (const site of rows.results) {
    try {
      await deleteSiteFiles(env, site.user_id, site.name);
      await env.DB
        .prepare("UPDATE sites SET status = 'deleted_cooling', cooling_until = ? WHERE id = ? AND status = 'deactivated'")
        .bind(coolingUntil, site.id)
        .run();
      reaped++;
    } catch (err) {
      console.error(`[anti-entropy] failed to reap deactivated site ${site.id}:`, err);
    }
  }

  if (reaped > 0) {
    console.log(`[anti-entropy] reaped ${reaped} deactivated site(s) into cooling`);
  }
}

// Delete R2 objects for superseded deploys whose cleanup was queued but never
// executed (e.g. queue message lost), then null out object_prefix so we don't
// re-process them. Works in a single page; re-runs tomorrow catch any remainder.
async function cleanupSupersededDeploys(env: Env): Promise<void> {
  const rows = await env.DB
    .prepare("SELECT id, site_id, object_prefix FROM deploys WHERE status = 'superseded' AND object_prefix IS NOT NULL LIMIT 50")
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
    console.log(`[anti-entropy] cleaned R2 for ${cleaned} superseded deploy(s)`);
  }
}

// Mark deploys that got stuck in 'uploading' for over an hour as failed.
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

// ── R2 cleanup ────────────────────────────────────────────────────────────────

async function deleteSiteFiles(env: Env, userId: string, siteName: string): Promise<void> {
  if (!userId || !siteName) {
    // Guard: never delete without a scoped prefix
    throw new Error(`Cannot delete site files: userId=${userId} siteName=${siteName}`);
  }

  const prefix = `sites/${userId}/${siteName}/`;
  let cursor: string | undefined;

  do {
    const list = await env.SITES.list({ prefix, limit: 1000, cursor });

    if (list.objects.length > 0) {
      const keys = list.objects.map(o => o.key);
      await env.SITES.delete(keys);
    }

    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  // Verify site is marked deleted in D1 before returning
  const site = await env.DB
    .prepare("SELECT status FROM sites WHERE id = (SELECT id FROM sites WHERE user_id = ? AND name = ? LIMIT 1)")
    .bind(userId, siteName)
    .first<{ status: string }>();

  // 'deactivated' is expected when called from reapDeactivatedSites — the status
  // flip to 'deleted_cooling' happens after this function returns.
  if (site && site.status !== 'deleted_cooling' && site.status !== 'deleted' && site.status !== 'deactivated') {
    console.warn(`Unexpected site status after delete cleanup: ${site.status}`);
  }
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

