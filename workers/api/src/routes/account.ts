import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { PLAN_LIMITS } from '../types';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

router.use('*', authMiddleware);

router.get('/usage', async c => {
  const { userId, plan } = c.get('auth');

  const siteCount = await c.env.DB
    .prepare("SELECT COUNT(*) as n FROM sites WHERE user_id = ? AND status IN ('active', 'suspended')")
    .bind(userId)
    .first<{ n: number }>();

  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  // Total storage: sum of latest deploy size per site
  const storage = await c.env.DB
    .prepare(`
      SELECT COALESCE(SUM(d.size_bytes), 0) as total
      FROM deploys d
      INNER JOIN (
        SELECT site_id, MAX(deployed_at) as latest
        FROM deploys
        GROUP BY site_id
      ) latest ON d.site_id = latest.site_id AND d.deployed_at = latest.latest
      INNER JOIN sites s ON s.id = d.site_id
      WHERE s.user_id = ?
    `)
    .bind(userId)
    .first<{ total: number }>();

  const monthDeployCount = await c.env.DB
    .prepare(`
      SELECT COUNT(*) as n FROM deploys d
      INNER JOIN sites s ON s.id = d.site_id
      WHERE s.user_id = ? AND d.deployed_at >= ? AND d.status != 'failed'
    `)
    .bind(userId, monthStart.getTime())
    .first<{ n: number }>();

  const window = Math.floor(Date.now() / (3600 * 1000));
  const apiCallCount = Number(await c.env.KV.get(`ratelimit:${userId}:${window}`) ?? '0');

  const limits = PLAN_LIMITS[plan];

  return c.json({
    plan,
    sites: { used: siteCount?.n ?? 0, limit: limits.sites },
    storage_bytes: {
      used: storage?.total ?? 0,
      limit: limits.size_bytes * limits.sites,
    },
    deploys_this_month: {
      used: monthDeployCount?.n ?? 0,
      limit: limits.deploys_per_month,
    },
    api_calls_this_hour: { used: apiCallCount, limit: limits.api_calls_per_hour },
  });
});

router.get('/account', async c => {
  const { userId } = c.get('auth');
  const user = await c.env.DB
    .prepare('SELECT id, email, plan, created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; plan: string; created_at: number }>();

  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found.' } }, 404);

  const key = await c.env.DB
    .prepare('SELECT prefix, created_at FROM api_keys WHERE user_id = ? AND rotated_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .bind(userId)
    .first<{ prefix: string; created_at: number }>();

  return c.json({
    user_id: user.id,
    email: user.email,
    plan: user.plan,
    created_at: new Date(user.created_at).toISOString(),
    api_key_prefix: key?.prefix ?? null,
  });
});

export default router;
