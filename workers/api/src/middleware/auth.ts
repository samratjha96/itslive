import type { Context, MiddlewareHandler } from 'hono';
import { sha256 } from '../lib/crypto';
import type { Env, AuthContext } from '../types';

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

const API_CALL_WINDOW_SECS = 3600;
const RATE_LIMITS: Record<string, number> = { free: 100, builder: 1000, studio: 10000 };

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // Reject keys in query params — key leakage risk
  const url = new URL(c.req.url);
  for (const param of ['api_key', 'apikey', 'api-key', 'key', 'token']) {
    if (url.searchParams.has(param)) {
      return c.json({ error: { code: 'KEY_IN_URL', message: 'API key must be sent in the X-API-Key header, not in the URL.' } }, 401);
    }
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
    const plan = cached.plan as AuthContext['plan'];
    const allowed = await enforceRateLimit(c.env, cached.key_id, plan);
    if (!allowed) {
      return c.json({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Try again later.' } }, 429, { 'Retry-After': String(API_CALL_WINDOW_SECS) });
    }
    c.set('auth', { userId: cached.user_id, plan, keyId: cached.key_id });
    return next();
  }

  const row = await c.env.DB
    .prepare('SELECT id, user_id, rotated_at FROM api_keys WHERE key_hash = ?')
    .bind(keyHash)
    .first<{ id: string; user_id: string; rotated_at: number | null }>();

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

  const plan = user.plan as AuthContext['plan'];
  const allowed = await enforceRateLimit(c.env, row.id, plan);
  if (!allowed) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded. Try again later.' } }, 429, { 'Retry-After': String(API_CALL_WINDOW_SECS) });
  }

  await c.env.KV.put(`apikey:${keyHash}`, JSON.stringify({ user_id: row.user_id, plan, key_id: row.id }), { expirationTtl: 60 });
  await c.env.DB.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').bind(Date.now(), row.id).run();

  c.set('auth', { userId: row.user_id, plan, keyId: row.id });
  return next();
};

// Reads current count, enforces limit, increments if allowed. Returns false if rate limited.
async function enforceRateLimit(env: Env, keyId: string, plan: string): Promise<boolean> {
  const window = Math.floor(Date.now() / (API_CALL_WINDOW_SECS * 1000));
  const kvKey = `ratelimit:${keyId}:${window}`;
  const current = Number(await env.KV.get(kvKey) ?? '0');
  const limit = RATE_LIMITS[plan] ?? 100;
  if (current >= limit) return false;
  await env.KV.put(kvKey, String(current + 1), { expirationTtl: API_CALL_WINDOW_SECS * 2 });
  return true;
}
