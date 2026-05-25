import { Hono } from 'hono';
import { z } from 'zod';
import { sha256, hashPassword } from '../lib/crypto';
import { ulid } from '../lib/id';
import { generateSlug, RESERVED_NAMES, SLUG_PATTERN } from '../lib/words';
import { authMiddleware } from '../middleware/auth';
import type { Env, Site } from '../types';
import { PLAN_LIMITS as LIMITS } from '../types';

const router = new Hono<{ Bindings: Env }>();

router.use('*', authMiddleware);

const CreateSiteSchema = z.object({
  name: z.string().optional(),
  type: z.enum(['static', 'dynamic']).default('static'),
});

const AccessSchema = z.object({
  password: z.string().min(8).max(128),
  session_ttl_hrs: z.number().int().min(1).max(168).default(24),
});

// ── POST /sites ──────────────────────────────────────────────────────────────

router.post('/', async c => {
  const { userId, plan } = c.get('auth');
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSiteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Invalid request body.' } }, 400);
  }
  const { name: requestedName, type } = parsed.data;

  if (type === 'dynamic' && plan === 'free') {
    return c.json({ error: { code: 'PLAN_REQUIRED', message: 'Dynamic sites require Builder plan or higher.' } }, 402);
  }

  const siteCount = await c.env.DB
    .prepare('SELECT COUNT(*) as n FROM sites WHERE user_id = ? AND status = ?')
    .bind(userId, 'active')
    .first<{ n: number }>();
  if ((siteCount?.n ?? 0) >= LIMITS[plan].sites) {
    return c.json({ error: { code: 'PLAN_LIMIT_REACHED', message: `Your ${plan} plan allows ${LIMITS[plan].sites} active sites.` } }, 402);
  }

  let siteName: string;
  let slugType: 'auto' | 'custom';

  if (requestedName) {
    if (plan === 'free') {
      return c.json({ error: { code: 'CUSTOM_SLUG_REQUIRES_PAID_PLAN', message: 'Custom site names require Builder plan or higher.' } }, 402);
    }
    if (!SLUG_PATTERN.test(requestedName)) {
      return c.json({ error: { code: 'NAME_INVALID', message: 'Site name must be 3-40 lowercase alphanumeric characters and hyphens.' } }, 400);
    }
    if (RESERVED_NAMES.has(requestedName)) {
      return c.json({ error: { code: 'NAME_RESERVED', message: 'This name is reserved.' } }, 409);
    }
    const taken = await c.env.DB
      .prepare("SELECT id FROM sites WHERE name = ? AND status != 'deleted'")
      .bind(requestedName)
      .first();
    // Check cooling period too
    const cooling = await c.env.DB
      .prepare("SELECT user_id, cooling_until FROM sites WHERE name = ? AND status = 'deleted_cooling'")
      .bind(requestedName)
      .first<{ user_id: string; cooling_until: number }>();
    if (cooling && cooling.user_id !== userId && cooling.cooling_until > Date.now()) {
      return c.json({ error: { code: 'NAME_TAKEN', message: 'This name is temporarily unavailable.' } }, 409);
    }
    if (taken) {
      return c.json({ error: { code: 'NAME_TAKEN', message: 'This site name is already taken.' } }, 409);
    }
    siteName = requestedName;
    slugType = 'custom';
  } else {
    siteName = await generateUniqueSlug(c.env);
    slugType = 'auto';
  }

  const siteId = ulid();
  const now = Date.now();

  await c.env.DB
    .prepare('INSERT INTO sites (id, user_id, name, slug_type, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(siteId, userId, siteName, slugType, type, 'active', now)
    .run();

  const url = siteUrl(c.env.SERVE_BASE_URL, siteName);
  return c.json({ site_id: siteId, url, slug_type: slugType, type, name: siteName, created_at: new Date(now).toISOString() }, 201);
});

// ── GET /sites ────────────────────────────────────────────────────────────────

router.get('/', async c => {
  const { userId } = c.get('auth');
  const sites = await c.env.DB
    .prepare("SELECT id, name, slug_type, type, status, deployed_at, password_hash FROM sites WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC")
    .bind(userId)
    .all<Site>();

  return c.json({
    sites: (sites.results ?? []).map(s => ({
      name: s.name,
      url: siteUrl(c.env.SERVE_BASE_URL, s.name),
      slug_type: s.slug_type,
      type: s.type,
      status: s.status,
      deployed_at: s.deployed_at ? new Date(s.deployed_at).toISOString() : null,
      password_protected: s.password_hash !== null,
    })),
  });
});

// ── GET /sites/:name ──────────────────────────────────────────────────────────

router.get('/:name', async c => {
  const { userId } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site) return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);

  const deploys = await c.env.DB
    .prepare('SELECT deployed_at, size_bytes, file_count, sha256, agent_ua FROM deploys WHERE site_id = ? ORDER BY deployed_at DESC LIMIT 5')
    .bind(site.id)
    .all<{ deployed_at: number; size_bytes: number; file_count: number; sha256: string; agent_ua: string | null }>();

  const deployCount = await c.env.DB
    .prepare('SELECT COUNT(*) as n FROM deploys WHERE site_id = ?')
    .bind(site.id)
    .first<{ n: number }>();

  return c.json({
    name: site.name,
    url: siteUrl(c.env.SERVE_BASE_URL, site.name),
    slug_type: site.slug_type,
    type: site.type,
    status: site.status,
    created_at: new Date(site.created_at).toISOString(),
    deployed_at: site.deployed_at ? new Date(site.deployed_at).toISOString() : null,
    password_protected: site.password_hash !== null,
    session_ttl_hrs: site.session_ttl_hrs,
    deploy_count: deployCount?.n ?? 0,
    last_5_deploys: (deploys.results ?? []).map(d => ({
      deployed_at: new Date(d.deployed_at).toISOString(),
      size_bytes: d.size_bytes,
      file_count: d.file_count,
      sha256: d.sha256,
    })),
  });
});

// ── PUT /sites/:name ──────────────────────────────────────────────────────────

router.put('/:name', async c => {
  const { userId, plan } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site || site.status !== 'active') {
    return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);
  }

  // Monthly deploy limit check
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const monthDeployCount = await c.env.DB
    .prepare('SELECT COUNT(*) as n FROM deploys WHERE site_id = ? AND deployed_at >= ?')
    .bind(site.id, monthStart.getTime())
    .first<{ n: number }>();
  const monthLimit = LIMITS[plan].deploys_per_month;
  if (monthLimit !== null && (monthDeployCount?.n ?? 0) >= monthLimit) {
    return c.json({ error: { code: 'PLAN_LIMIT_REACHED', message: `Monthly deploy limit (${monthLimit}) reached.` } }, 402);
  }

  const cacheTtlHeader = c.req.header('X-Cache-TTL');
  const cacheTtl = Math.min(86400, Math.max(30, Number(cacheTtlHeader ?? '300'))) || 300;

  const contentType = c.req.header('Content-Type') ?? '';
  const files: { path: string; body: Uint8Array; contentType: string }[] = [];

  if (contentType.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    for (const [, value] of form.entries()) {
      // Blob/File values have arrayBuffer; string values do not
      if (typeof value !== 'string' && 'arrayBuffer' in value) {
        const file = value as Blob & { name?: string; type: string };
        const bytes = new Uint8Array(await file.arrayBuffer());
        const safePath = sanitizePath((file as { name?: string }).name ?? 'index.html');
        if (!safePath) continue;
        files.push({ path: safePath, body: bytes, contentType: file.type || inferContentType(safePath) });
      }
    }
    if (files.length === 0) {
      return c.json({ error: { code: 'NO_FILES', message: 'No files provided.' } }, 400);
    }
  } else {
    // Single file as raw body
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    files.push({ path: 'index.html', body: bytes, contentType: 'text/html; charset=utf-8' });
  }

  const totalSize = files.reduce((acc, f) => acc + f.body.byteLength, 0);
  if (totalSize > LIMITS[plan].size_bytes) {
    const mb = (LIMITS[plan].size_bytes / (1024 * 1024)).toFixed(0);
    return c.json({ error: { code: 'FILE_TOO_LARGE', message: `Total size exceeds ${mb}MB limit for ${plan} plan.` } }, 413);
  }

  const now = Date.now();
  const deployId = ulid();

  // Write files to R2 — path is always server-constructed
  for (const file of files) {
    const r2Key = `sites/${userId}/${name}/${file.path}`;
    await c.env.SITES.put(r2Key, file.body, {
      httpMetadata: {
        contentType: file.contentType,
        cacheControl: `public, max-age=${cacheTtl}`,
      },
      customMetadata: { deploy_id: deployId },
    });
  }

  // Compute combined sha256 for deploy record
  const combined = files.map(f => f.path + ':' + f.body.byteLength).join('|');
  const deployHash = await sha256(combined);

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO deploys (id, site_id, deployed_at, size_bytes, file_count, sha256, agent_ua) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(deployId, site.id, now, totalSize, files.length, deployHash, c.req.header('User-Agent') ?? null),
    c.env.DB.prepare('UPDATE sites SET deployed_at = ? WHERE id = ?').bind(now, site.id),
  ]);

  await c.env.QUEUE.send({ type: 'post_deploy_cache_purge', site_name: name });

  const url = siteUrl(c.env.SERVE_BASE_URL, name);
  return c.json({ url, deployed_at: new Date(now).toISOString(), size_bytes: totalSize, file_count: files.length, sha256: deployHash });
});

// ── DELETE /sites/:name ───────────────────────────────────────────────────────

router.delete('/:name', async c => {
  const { userId } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site) return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);

  const coolingUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await c.env.DB
    .prepare("UPDATE sites SET status = 'deleted_cooling', cooling_until = ? WHERE id = ?")
    .bind(coolingUntil, site.id)
    .run();

  await c.env.KV.delete(`site:${name}`);
  await c.env.QUEUE.send({ type: 'site_delete_cleanup', site_id: site.id, user_id: userId, site_name: name });

  return c.json({ deleted: true, cooling_until: new Date(coolingUntil).toISOString() });
});

// ── PUT /sites/:name/access ───────────────────────────────────────────────────

router.put('/:name/access', async c => {
  const { userId, plan } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site || site.status !== 'active') {
    return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = AccessSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Password must be 8-128 characters.' } }, 400);
  }

  let { password, session_ttl_hrs } = parsed.data;
  if (plan === 'free') session_ttl_hrs = 24; // Fixed on free tier

  const hash = await hashPassword(password);

  await c.env.DB
    .prepare('UPDATE sites SET password_hash = ?, session_ttl_hrs = ? WHERE id = ?')
    .bind(hash, session_ttl_hrs, site.id)
    .run();

  await revokeAllSessions(c.env, site.id);
  await c.env.KV.delete(`site:${name}`);

  return c.json({ password_protected: true, session_ttl_hrs });
});

// ── DELETE /sites/:name/access ────────────────────────────────────────────────

router.delete('/:name/access', async c => {
  const { userId } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site) return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);

  await c.env.DB.prepare('UPDATE sites SET password_hash = NULL WHERE id = ?').bind(site.id).run();
  await revokeAllSessions(c.env, site.id);
  await c.env.KV.delete(`site:${name}`);

  return c.json({ password_protected: false });
});

// ── POST /sites/:name/access/revoke ──────────────────────────────────────────

router.post('/:name/access/revoke', async c => {
  const { userId } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site) return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);

  const count = await revokeAllSessions(c.env, site.id);
  return c.json({ sessions_revoked: count });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function siteUrl(serveBase: string, name: string): string {
  return `${serveBase}/${name}`;
}

async function getSiteForUser(env: Env, userId: string, name: string): Promise<Site | null> {
  return env.DB
    .prepare("SELECT * FROM sites WHERE name = ? AND user_id = ? AND status != 'deleted'")
    .bind(name, userId)
    .first<Site>();
}

async function generateUniqueSlug(env: Env): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const slug = generateSlug();
    if (RESERVED_NAMES.has(slug)) continue;

    const lockKey = `slug_lock:${slug}`;
    const locked = await env.KV.get(lockKey);
    if (locked) continue;

    const taken = await env.DB
      .prepare("SELECT id FROM sites WHERE name = ? AND status != 'deleted'")
      .bind(slug)
      .first();
    if (!taken) {
      // KV minimum TTL is 60s. Lock briefly to prevent concurrent slug collisions.
      await env.KV.put(lockKey, '1', { expirationTtl: 60 });
      return slug;
    }
  }
  throw new Error('SLUG_GENERATION_FAILED');
}

async function revokeAllSessions(env: Env, siteId: string): Promise<number> {
  // List sessions for this site then delete individually (KV has no atomic prefix delete)
  const prefix = `session:${siteId}:`;
  let count = 0;
  let cursor: string | undefined;

  do {
    const list = await env.KV.list({ prefix, limit: 1000, cursor });
    for (const key of list.keys) {
      await env.KV.delete(key.name);
      count++;
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return count;
}

// Sanitize uploaded file paths — prevent path traversal
function sanitizePath(rawPath: string): string | null {
  // Strip leading slashes and resolve ..
  const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const safe: string[] = [];
  for (const part of parts) {
    if (part === '..') return null; // Reject any path traversal attempt
    if (part === '.') continue;
    safe.push(part);
  }
  if (safe.length === 0) return 'index.html';
  return safe.join('/');
}

function inferContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    xml: 'application/xml',
    wasm: 'application/wasm',
  };
  return types[ext ?? ''] ?? 'application/octet-stream';
}

export default router;
