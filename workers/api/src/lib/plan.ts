import type { Env } from '../types';
import { PLAN_LIMITS } from './limits';
import { invalidateUserKeyCache } from '../middleware/auth';
import { suspendSites, unsuspendSites as applyUnsuspend } from './siteStatus';

export type { Plan } from './limits';

// Called by the Stripe webhook handler when a subscription is downgraded or
// cancelled. Suspends the newest sites that exceed the new plan's site limit.
// Oldest sites are kept active — users keep what they built longest.
export async function suspendExcessSites(env: Env, userId: string, plan: keyof typeof PLAN_LIMITS): Promise<void> {
  const limit = PLAN_LIMITS[plan].sites;

  const sites = await env.DB
    .prepare("SELECT id, name FROM sites WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC")
    .bind(userId)
    .all<{ id: string; name: string }>();

  const toSuspend = (sites.results ?? []).slice(limit);
  await suspendSites(env, toSuspend);
}

// Called by the Stripe webhook handler when a subscription is upgraded or
// reinstated. Re-activates all suspended sites owned by the user.
export async function unsuspendSites(env: Env, userId: string): Promise<void> {
  const suspended = await env.DB
    .prepare("SELECT id, name FROM sites WHERE user_id = ? AND status = 'suspended'")
    .bind(userId)
    .all<{ id: string; name: string }>();

  await applyUnsuspend(env, suspended.results ?? []);
}

// Purges serve-worker KV caches for all sites owned by a user. Called on plan
// changes so the serve worker picks up new session_ttl and plan fields promptly
// rather than serving stale KV for up to 60s.
async function invalidateAllSiteCaches(env: Env, userId: string): Promise<void> {
  try {
    const sites = await env.DB
      .prepare("SELECT name FROM sites WHERE user_id = ? AND status != 'deleted'")
      .bind(userId)
      .all<{ name: string }>();
    const names = (sites.results ?? []).map(s => s.name);
    const chunkSize = 50;
    for (let i = 0; i < names.length; i += chunkSize) {
      const chunk = names.slice(i, i + chunkSize);
      await Promise.all(chunk.map(name => env.KV.delete(`site:${name}`).catch(() => {})));
    }
  } catch (err) {
    console.warn(`plan: site KV cache invalidation failed for user ${userId}:`, err);
  }
}

// Reconciles users.plan and site statuses atomically from billing_purchases,
// or applies an explicit targetPlan when passed directly.
export async function applyPlanChange(env: Env, userId: string, targetPlan?: keyof typeof PLAN_LIMITS): Promise<void> {
  if (targetPlan) {
    const limit = PLAN_LIMITS[targetPlan].sites;
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(targetPlan, userId),
      env.DB.prepare(
        `UPDATE sites
         SET status = CASE
           WHEN id IN (
             SELECT id FROM sites
             WHERE user_id = ? AND status IN ('active', 'suspended')
             ORDER BY created_at ASC, id ASC
             LIMIT ?
           ) THEN 'active'
           ELSE 'suspended'
         END
         WHERE user_id = ? AND status IN ('active', 'suspended')`
      ).bind(userId, limit, userId),
    ]);
  } else {
    const proLimit = PLAN_LIMITS.pro.sites;
    const freeLimit = PLAN_LIMITS.free.sites;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
         SET plan = CASE
           WHEN EXISTS (
             SELECT 1 FROM billing_purchases
             WHERE user_id = ? AND paid = 1 AND refunded = 0 AND dispute_status IN ('none', 'won')
           ) THEN 'pro'
           ELSE 'free'
         END
         WHERE id = ?`
      ).bind(userId, userId),
      env.DB.prepare(
        `UPDATE sites
         SET status = CASE
           WHEN id IN (
             SELECT id FROM sites
             WHERE user_id = ? AND status IN ('active', 'suspended')
             ORDER BY created_at ASC, id ASC
             LIMIT (
               CASE
                 WHEN (SELECT plan FROM users WHERE id = ?) = 'pro' THEN ?
                 ELSE ?
               END
             )
           ) THEN 'active'
           ELSE 'suspended'
         END
         WHERE user_id = ? AND status IN ('active', 'suspended')`
      ).bind(userId, userId, proLimit, freeLimit, userId),
    ]);
  }

  await Promise.all([
    invalidateUserKeyCache(env, userId),
    invalidateAllSiteCaches(env, userId),
  ]);
}
