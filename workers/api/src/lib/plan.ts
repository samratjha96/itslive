import type { Env } from '../types';
import { PLAN_LIMITS } from '../types';
import { invalidateUserKeyCache } from '../middleware/auth';

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
  if (toSuspend.length === 0) return;

  await env.DB.batch(
    toSuspend.map(s => env.DB.prepare("UPDATE sites SET status = 'suspended' WHERE id = ?").bind(s.id))
  );

  // Bust serve-worker KV cache for each suspended site
  await Promise.all(toSuspend.map(s => env.KV.delete(`site:${s.name}`)));
}

// Called by the Stripe webhook handler when a subscription is upgraded or
// reinstated. Re-activates all suspended sites owned by the user.
export async function unsuspendSites(env: Env, userId: string): Promise<void> {
  const suspended = await env.DB
    .prepare("SELECT id, name FROM sites WHERE user_id = ? AND status = 'suspended'")
    .bind(userId)
    .all<{ id: string; name: string }>();

  if ((suspended.results ?? []).length === 0) return;

  await env.DB.batch(
    suspended.results.map(s => env.DB.prepare("UPDATE sites SET status = 'active' WHERE id = ?").bind(s.id))
  );

  await Promise.all(suspended.results.map(s => env.KV.delete(`site:${s.name}`)));
}

// Purges serve-worker KV caches for all sites owned by a user. Called on plan
// changes so the serve worker picks up new session_ttl and plan fields promptly
// rather than serving stale KV for up to 60s.
async function invalidateAllSiteCaches(env: Env, userId: string): Promise<void> {
  const sites = await env.DB
    .prepare("SELECT name FROM sites WHERE user_id = ? AND status != 'deleted'")
    .bind(userId)
    .all<{ name: string }>();
  await Promise.all((sites.results ?? []).map(s => env.KV.delete(`site:${s.name}`)));
}

// Convenience wrapper: update users.plan, invalidate KV caches, and enforce
// resource limits in one call. This is the single entry point for the Stripe
// webhook handler — pass the new plan from Stripe's subscription object.
export async function applyPlanChange(env: Env, userId: string, newPlan: keyof typeof PLAN_LIMITS): Promise<void> {
  await env.DB
    .prepare('UPDATE users SET plan = ? WHERE id = ?')
    .bind(newPlan, userId)
    .run();

  // Purge API key and site KV caches so the new plan takes effect immediately
  await Promise.all([
    invalidateUserKeyCache(env, userId),
    invalidateAllSiteCaches(env, userId),
  ]);

  // Enforce resource limits for the new plan
  await suspendExcessSites(env, userId, newPlan);
}
