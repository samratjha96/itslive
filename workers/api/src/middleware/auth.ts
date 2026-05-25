import type { Context, MiddlewareHandler, Next } from 'hono';
import { sha256, timingSafeEqual } from '../lib/crypto';
import type { Env, AuthContext } from '../types';

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

const API_CALL_WINDOW_SECS = 3600;

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Reject keys in query params — key leakage risk
  if (c.req.query('api_key') || c.req.query('key') || c.req.query('token')) {
    return c.json({ error: { code: 'KEY_IN_URL', message: 'API key must be sent in the X-API-Key header, not in the URL.' } }, 401);
  }

  const raw = c.req.header('X-API-Key');
  if (!raw) {
    return c.json({ error: { code: 'MISSING_KEY', message: 'X-API-Key header is required.' } }, 401);
  }
  if (!raw.startsWith('il_live_') && !raw.startsWith('il_test_')) {
    return c.json({ error: { code: 'INVALID_KEY', message: 'Invalid API key format.' } }, 401);
  }

  const keyHash = await sha256(raw);

  // KV warm cache (60s TTL). Miss falls through to D1.
  const cached = await c.env.KV.get(`apikey:${keyHash}`, 'json') as { user_id: string; plan: string; key_id: string } | null;
  if (cached) {
    c.set('auth', { userId: cached.user_id, plan: cached.plan as AuthContext['plan'], keyId: cached.key_id });
    await trackApiCall(c, cached.key_id, cached.plan as AuthContext['plan']);
    return next();
  }

  const row = await c.env.DB
    .prepare('SELECT id, user_id, key_hash, rotated_at FROM api_keys WHERE key_hash = ?')
    .bind(keyHash)
    .first<{ id: string; user_id: string; key_hash: string; rotated_at: number | null }>();

  if (!row) {
    return c.json({ error: { code: 'INVALID_KEY', message: 'API key not found.' } }, 401);
  }

  // A rotated key is valid for 60s grace period after rotation
  if (row.rotated_at) {
    const gracePeriodMs = 60_000;
    if (Date.now() - row.rotated_at > gracePeriodMs) {
      return c.json({ error: { code: 'KEY_ROTATED', message: 'This key has been rotated. Use your new key.' } }, 401);
    }
  }

  const user = await c.env.DB
    .prepare('SELECT plan FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<{ plan: string }>();

  if (!user) {
    return c.json({ error: { code: 'INVALID_KEY', message: 'Account not found.' } }, 401);
  }

  // Verify hash with timing-safe comparison
  if (!timingSafeEqual(row.key_hash, keyHash)) {
    return c.json({ error: { code: 'INVALID_KEY', message: 'Invalid API key.' } }, 401);
  }

  const plan = user.plan as AuthContext['plan'];
  await c.env.KV.put(`apikey:${keyHash}`, JSON.stringify({ user_id: row.user_id, plan, key_id: row.id }), { expirationTtl: 60 });
  await c.env.DB.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').bind(Date.now(), row.id).run();

  c.set('auth', { userId: row.user_id, plan, keyId: row.id });
  await trackApiCall(c, row.id, plan);
  return next();
};

async function trackApiCall(c: Context<{ Bindings: Env }>, keyId: string, plan: string): Promise<void> {
  const window = Math.floor(Date.now() / (API_CALL_WINDOW_SECS * 1000));
  const kvKey = `ratelimit:${keyId}:${window}`;

  const current = Number(await c.env.KV.get(kvKey) ?? '0');
  const limits = { free: 100, builder: 1000, studio: 10000 } as Record<string, number>;
  const limit = limits[plan] ?? 100;

  if (current >= limit) {
    // We return after setting the header in a 429 — but middleware can't abort after auth.
    // Rate limit check happens before this function; we only track here.
    // The actual check is done inline where needed for now.
  }
  await c.env.KV.put(kvKey, String(current + 1), { expirationTtl: API_CALL_WINDOW_SECS * 2 });
}

export async function checkRateLimit(env: Env, keyId: string, plan: string): Promise<boolean> {
  const window = Math.floor(Date.now() / (API_CALL_WINDOW_SECS * 1000));
  const kvKey = `ratelimit:${keyId}:${window}`;
  const current = Number(await env.KV.get(kvKey) ?? '0');
  const limits: Record<string, number> = { free: 100, builder: 1000, studio: 10000 };
  return current < (limits[plan] ?? 100);
}
