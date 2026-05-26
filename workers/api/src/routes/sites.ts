import { Hono } from 'hono';
import { z } from 'zod';
import { unzipSync } from 'fflate';
import { sha256, hashPassword } from '../lib/crypto';
import { ulid } from '../lib/id';
import { generateSlug, RESERVED_NAMES, SLUG_PATTERN } from '../lib/words';
import { authMiddleware } from '../middleware/auth';
import type { Env, Site } from '../types';
import { PLAN_LIMITS } from '../types';

const router = new Hono<{ Bindings: Env }>();

router.use('*', authMiddleware);

const CreateSiteSchema = z.object({
  name: z.string().optional(),
});

const AccessSchema = z.object({
  password: z.string().min(8).max(128),
  session_ttl_hrs: z.number().int().min(1).max(720).default(24),
});

// ── POST /sites ──────────────────────────────────────────────────────────────

router.post('/', async c => {
  const { userId, plan } = c.get('auth');
  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateSiteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Invalid request body.' } }, 400);
  }
  const { name: requestedName } = parsed.data;

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
    const existing = await c.env.DB
      .prepare("SELECT id, user_id, status, cooling_until FROM sites WHERE name = ? AND status != 'deleted'")
      .bind(requestedName)
      .first<{ id: string; user_id: string; status: string; cooling_until: number | null }>();

    if (existing) {
      if (existing.status !== 'deleted_cooling') {
        return c.json({ error: { code: 'NAME_TAKEN', message: 'This site name is already taken.' } }, 409);
      }
      if (existing.user_id === userId) {
        return c.json({ error: { code: 'SITE_IN_COOLING', message: 'This site is in its cooling-off period. Wait for it to fully expire before reusing the name.' } }, 409);
      }
      if ((existing.cooling_until ?? Infinity) > Date.now()) {
        return c.json({ error: { code: 'NAME_TAKEN', message: 'This name is temporarily unavailable.' } }, 409);
      }
      // Expired cooling — flip to deleted so INSERT can proceed.
      // UNIQUE constraint on name handles concurrent races via the catch block below.
      await c.env.DB
        .prepare("UPDATE sites SET status = 'deleted' WHERE id = ? AND status = 'deleted_cooling'")
        .bind(existing.id)
        .run();
    }
    siteName = requestedName;
    slugType = 'custom';
  } else {
    siteName = await generateUniqueSlug(c.env);
    slugType = 'auto';
  }

  const siteId = ulid();
  const now = Date.now();
  const limit = PLAN_LIMITS[plan].sites;

  // Atomic site-count check + insert: the WHERE clause guards the limit and
  // runs in a single SQLite statement, eliminating the TOCTOU race.
  let insertResult;
  try {
    insertResult = await c.env.DB
      .prepare(
        `INSERT INTO sites (id, user_id, name, slug_type, type, status, created_at)
         SELECT ?, ?, ?, ?, 'static', 'active', ?
         WHERE (SELECT COUNT(*) FROM sites WHERE user_id = ? AND status IN ('active', 'suspended')) < ?`
      )
      .bind(siteId, userId, siteName, slugType, now, userId, limit)
      .run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      const code = slugType === 'custom' ? 'NAME_TAKEN' : 'SLUG_GENERATION_FAILED';
      const message = slugType === 'custom' ? 'This site name is already taken.' : 'Failed to generate a unique name. Please try again.';
      return c.json({ error: { code, message } }, 409);
    }
    throw err;
  }

  if (insertResult.meta.changes === 0) {
    return c.json({ error: { code: 'PLAN_LIMIT_REACHED', message: `Your ${plan} plan allows ${limit} active sites.` } }, 402);
  }

  const url = siteUrl(c.env.SERVE_DOMAIN, siteName);
  return c.json({ site_id: siteId, url, slug_type: slugType, name: siteName, created_at: new Date(now).toISOString() }, 201);
});

// ── GET /sites ────────────────────────────────────────────────────────────────

router.get('/', async c => {
  const { userId } = c.get('auth');
  const sites = await c.env.DB
    .prepare("SELECT id, name, slug_type, type, status, deployed_at, password_hash FROM sites WHERE user_id = ? AND status IN ('active', 'suspended', 'deactivated') ORDER BY created_at DESC")
    .bind(userId)
    .all<Site>();

  return c.json({
    sites: (sites.results ?? []).map(s => ({
      name: s.name,
      url: siteUrl(c.env.SERVE_DOMAIN, s.name),
      slug_type: s.slug_type,
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

  const [deploysRes, countRes] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, deployed_at, size_bytes, file_count, sha256, status FROM deploys WHERE site_id = ? ORDER BY deployed_at DESC LIMIT 5').bind(site.id),
    c.env.DB.prepare('SELECT COUNT(*) as n FROM deploys WHERE site_id = ?').bind(site.id),
  ]);
  const deploys = deploysRes.results as { id: string; deployed_at: number; size_bytes: number; file_count: number; sha256: string; status: string }[];
  const deployCount = countRes.results[0] as { n: number } | undefined;

  return c.json({
    name: site.name,
    url: siteUrl(c.env.SERVE_DOMAIN, site.name),
    slug_type: site.slug_type,
    status: site.status,
    created_at: new Date(site.created_at).toISOString(),
    deployed_at: site.deployed_at ? new Date(site.deployed_at).toISOString() : null,
    active_deploy_id: site.active_deploy_id,
    password_protected: site.password_hash !== null,
    session_ttl_hrs: site.session_ttl_hrs,
    deploy_count: deployCount?.n ?? 0,
    last_5_deploys: deploys.map(d => ({
      deploy_id: d.id,
      deployed_at: new Date(d.deployed_at).toISOString(),
      size_bytes: d.size_bytes,
      file_count: d.file_count,
      sha256: d.sha256,
      status: d.status,
    })),
  });
});

// ── POST /sites/:name/restore ─────────────────────────────────────────────────

router.post('/:name/restore', async c => {
  const { userId } = c.get('auth');
  const name = c.req.param('name');

  const site = await c.env.DB
    .prepare("SELECT * FROM sites WHERE name = ? AND user_id = ? AND status = 'deactivated'")
    .bind(name, userId)
    .first<Site>();

  if (!site) {
    return c.json({ error: { code: 'SITE_NOT_RESTORABLE', message: 'Site not found, already purged, or not in a deactivated state.' } }, 404);
  }

  await c.env.DB
    .prepare("UPDATE sites SET status = 'active', cooling_until = NULL WHERE id = ?")
    .bind(site.id)
    .run();

  await c.env.KV.delete(`site:${name}`);

  return c.json({ restored: true, url: siteUrl(c.env.SERVE_DOMAIN, name) });
});

// ── PUT /sites/:name ──────────────────────────────────────────────────────────

router.put('/:name', async c => {
  const { userId, plan } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site) {
    return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);
  }
  if (site.status === 'suspended') {
    return c.json({ error: { code: 'SITE_SUSPENDED', message: 'This site is suspended. Upgrade your plan to resume deploys.' } }, 402);
  }
  if (site.status !== 'active') {
    return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);
  }

  // Monthly deploy limit is per-user across all sites, not per-site.
  // Excludes failed deploys — only attempts that consumed quota count.
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const monthDeployCount = await c.env.DB
    .prepare(
      `SELECT COUNT(*) as n FROM deploys d
       JOIN sites s ON d.site_id = s.id
       WHERE s.user_id = ? AND d.deployed_at >= ? AND d.status != 'failed'`
    )
    .bind(userId, monthStart.getTime())
    .first<{ n: number }>();
  const monthLimit = PLAN_LIMITS[plan].deploys_per_month;
  if (monthLimit !== null && (monthDeployCount?.n ?? 0) >= monthLimit) {
    return c.json({ error: { code: 'PLAN_LIMIT_REACHED', message: `Monthly deploy limit (${monthLimit}) reached.` } }, 402);
  }

  const cacheTtlHeader = c.req.header('X-Cache-TTL');
  const cacheTtl = Math.min(86400, Math.max(30, Number(cacheTtlHeader ?? '300'))) || 300;

  const contentType = c.req.header('Content-Type') ?? '';
  const planSizeBytes = PLAN_LIMITS[plan].size_bytes;
  const tooLarge = () => {
    const mb = (planSizeBytes / (1024 * 1024)).toFixed(0);
    return c.json({ error: { code: 'FILE_TOO_LARGE', message: `Total size exceeds ${mb}MB limit for ${plan} plan.` } }, 413);
  };

  // Reject obviously oversized requests before reading the body into memory.
  // This covers raw HTML and multipart exactly, and ZIP by compressed size
  // (a compressed file larger than the plan limit is always too big).
  const contentLength = parseInt(c.req.header('Content-Length') ?? '', 10);
  if (!isNaN(contentLength) && contentLength > planSizeBytes) {
    return tooLarge();
  }

  const files: { path: string; body: Uint8Array; contentType: string }[] = [];

  if (contentType.startsWith('application/zip') || contentType === 'application/octet-stream') {
    const bytes = new Uint8Array(await c.req.arrayBuffer());

    // Guard against ZIP bombs by reading declared uncompressed sizes from the
    // ZIP central directory before decompressing. Prevents OOM in unzipSync.
    const declaredSize = getZipDeclaredUncompressedSize(bytes);
    if (declaredSize > planSizeBytes) {
      return tooLarge();
    }

    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(bytes);
    } catch {
      return c.json({ error: { code: 'INVALID_ZIP', message: 'Could not parse ZIP archive.' } }, 400);
    }
    for (const [rawPath, data] of Object.entries(unzipped)) {
      if (rawPath.endsWith('/')) continue; // skip directory entries
      const safePath = sanitizePath(rawPath);
      if (!safePath) continue;
      files.push({ path: safePath, body: data, contentType: inferContentType(safePath) });
    }
  } else if (contentType.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    for (const [, value] of form.entries()) {
      if (typeof value !== 'string' && 'arrayBuffer' in value) {
        const file = value as Blob & { name?: string; type: string };
        const bytes = new Uint8Array(await file.arrayBuffer());
        const safePath = sanitizePath((file as { name?: string }).name ?? 'index.html');
        if (!safePath) continue;
        files.push({ path: safePath, body: bytes, contentType: file.type || inferContentType(safePath) });
      }
    }
  } else {
    // Raw body — treat as single index.html
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    files.push({ path: 'index.html', body: bytes, contentType: 'text/html; charset=utf-8' });
  }

  if (files.length === 0) {
    return c.json({ error: { code: 'NO_FILES', message: 'No files provided.' } }, 400);
  }
  if (!files.some(f => f.path === 'index.html')) {
    return c.json({ error: { code: 'ENTRYPOINT_MISSING', message: 'Deploy must include index.html.' } }, 400);
  }
  if (files.length > 100) {
    return c.json({ error: { code: 'TOO_MANY_FILES', message: 'Deploy cannot exceed 100 files.' } }, 400);
  }

  const totalSize = files.reduce((acc, f) => acc + f.body.byteLength, 0);
  if (totalSize > planSizeBytes) {
    return tooLarge();
  }

  const now = Date.now();
  const deployId = ulid();
  const objectPrefix = `sites/${userId}/${name}/${deployId}`;
  const combined = files.map(f => f.path + ':' + f.body.byteLength).join('|');
  const deployHash = await sha256(combined);

  // Insert deploy record as 'uploading' before touching R2.
  // If R2 writes fail, the deploy stays 'uploading' and the old version remains live.
  await c.env.DB
    .prepare('INSERT INTO deploys (id, site_id, deployed_at, size_bytes, file_count, sha256, status, object_prefix, agent_ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(deployId, site.id, now, totalSize, files.length, deployHash, 'uploading', objectPrefix, c.req.header('User-Agent') ?? null)
    .run();

  for (const file of files) {
    await c.env.SITES.put(`${objectPrefix}/${file.path}`, file.body, {
      httpMetadata: {
        contentType: file.contentType,
        cacheControl: `public, max-age=${cacheTtl}`,
      },
      customMetadata: { deploy_id: deployId },
    });
  }

  // Atomic flip: mark new deploy active, supersede old one, update site pointer
  const flipStatements = [
    c.env.DB.prepare("UPDATE deploys SET status = 'active' WHERE id = ?").bind(deployId),
    c.env.DB.prepare('UPDATE sites SET deployed_at = ?, active_deploy_id = ? WHERE id = ?').bind(now, deployId, site.id),
  ];
  if (site.active_deploy_id) {
    flipStatements.push(
      c.env.DB.prepare("UPDATE deploys SET status = 'superseded' WHERE id = ?").bind(site.active_deploy_id)
    );
  }
  await c.env.DB.batch(flipStatements);

  await c.env.QUEUE.send({ type: 'post_deploy_cache_purge', site_name: name });
  if (site.active_deploy_id) {
    await c.env.QUEUE.send({ type: 'deploy_cleanup', site_id: site.id, deploy_id: site.active_deploy_id });
  }

  const url = siteUrl(c.env.SERVE_DOMAIN, name);
  return c.json({ url, deploy_id: deployId, deployed_at: new Date(now).toISOString(), size_bytes: totalSize, file_count: files.length, sha256: deployHash });
});

// ── DELETE /sites/:name ───────────────────────────────────────────────────────

router.delete('/:name', async c => {
  const { userId } = c.get('auth');
  const name = c.req.param('name');
  const site = await getSiteForUser(c.env, userId, name);
  if (!site) return c.json({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }, 404);
  if (site.status === 'deactivated') {
    return c.json({ error: { code: 'ALREADY_DEACTIVATED', message: 'Site is already deactivated. Use POST /sites/:name/restore to bring it back.' } }, 409);
  }

  // Soft delete: site is invisible immediately but R2 files are preserved for
  // 7 days so the owner can restore. The anti-entropy cron handles cleanup.
  const reapAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await c.env.DB
    .prepare("UPDATE sites SET status = 'deactivated', cooling_until = ? WHERE id = ?")
    .bind(reapAt, site.id)
    .run();

  await c.env.KV.delete(`site:${name}`);

  return c.json({ deactivated: true, restorable_until: new Date(reapAt).toISOString() });
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

  const { password } = parsed.data;
  const session_ttl_hrs = Math.min(parsed.data.session_ttl_hrs, PLAN_LIMITS[plan].session_ttl_hrs);

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

function siteUrl(domain: string, name: string): string {
  return `https://${name}.${domain}`;
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
  const prefix = `session:${siteId}:`;
  let count = 0;
  let cursor: string | undefined;

  do {
    const list = await env.KV.list({ prefix, limit: 1000, cursor });
    await Promise.all(list.keys.map(k => env.KV.delete(k.name)));
    count += list.keys.length;
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

// Reads declared uncompressed sizes from the ZIP central directory without
// decompressing. Returns the total, or Infinity if the file is unparseable.
// This catches ZIP bombs before unzipSync ever runs.
function getZipDeclaredUncompressedSize(bytes: Uint8Array): number {
  if (bytes.length < 22) return Infinity;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory record (signature 0x06054b50, little-endian).
  // It sits at most 65558 bytes from the end (max comment length + fixed size).
  let eocdOffset = -1;
  const searchStart = Math.max(0, bytes.length - 65558);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return Infinity;

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdSize   = view.getUint32(eocdOffset + 12, true);
  if (cdOffset + cdSize > bytes.length) return Infinity;

  let total = 0;
  let pos = cdOffset;
  const end = cdOffset + cdSize;

  while (pos + 46 <= end) {
    if (view.getUint32(pos, true) !== 0x02014b50) break; // central directory entry signature
    const uncompressedSize = view.getUint32(pos + 24, true);
    // 0xFFFFFFFF signals ZIP64 — treat as unknown and let post-extraction check handle it
    if (uncompressedSize === 0xFFFFFFFF) return Infinity;
    total += uncompressedSize;
    if (total > 200 * 1024 * 1024) return total; // early-exit past any reasonable plan limit
    const fileNameLen = view.getUint16(pos + 28, true);
    const extraLen   = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  return total;
}

export default router;
