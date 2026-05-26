interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITES: R2Bucket;
}

interface SiteRecord {
  id: string;
  user_id: string;
  name: string;
  status: string;
  cooling_until: number | null;
  active_deploy_id: string | null;
  password_protected: boolean;
  session_ttl_hrs: number;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src 'self' fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https:",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Root — serve landing page from R2 (update by uploading to _landing/index.html)
    if (pathParts.length === 0) {
      const landing = await env.SITES.get('_landing/index.html');
      if (landing && 'body' in landing) {
        return new Response(landing.body, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
        });
      }
      return new Response('ItsLive', { headers: { 'Content-Type': 'text/plain' } });
    }

    const siteName = pathParts[0];
    const rawFilePath = pathParts.slice(1).join('/') || 'index.html';
    const filePath = sanitizeFilePath(rawFilePath);
    if (!filePath) {
      return new Response('Bad request', { status: 400 });
    }

    const site = await lookupSite(env, siteName);

    if (!site) {
      return notFound(siteName);
    }

    if (site.status === 'deleted_cooling') {
      return gone(siteName);
    }

    if (site.status !== 'active') {
      return notFound(siteName);
    }

    if (!site.active_deploy_id) {
      return notDeployed(siteName);
    }

    // Password protection
    if (site.password_protected) {
      // POST /__auth is the login form submission (never cached)
      if (request.method === 'POST' && filePath === '__auth') {
        return handleLogin(request, env, site);
      }

      const session = await getValidSession(request, env, site);
      if (!session) {
        // GET requests get login page; other methods get 401
        if (request.method !== 'GET') {
          return new Response('Unauthorized', { status: 401 });
        }
        return loginPage(site.name, null);
      }
    }

    return serveFile(env, site, filePath, request);
  },
} satisfies ExportedHandler<Env>;

// ── Site lookup ───────────────────────────────────────────────────────────────

async function lookupSite(env: Env, name: string): Promise<SiteRecord | null> {
  const kvKey = `site:${name}`;
  const cached = await env.KV.get(kvKey, 'json') as SiteRecord | null;
  if (cached) return cached;

  const row = await env.DB
    .prepare("SELECT id, user_id, name, status, cooling_until, active_deploy_id, password_hash, session_ttl_hrs FROM sites WHERE name = ? AND status != 'deleted'")
    .bind(name)
    .first<{
      id: string; user_id: string; name: string; status: string;
      cooling_until: number | null; active_deploy_id: string | null;
      password_hash: string | null; session_ttl_hrs: number;
    }>();

  if (!row) return null;

  const record: SiteRecord = {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    status: row.status,
    cooling_until: row.cooling_until,
    active_deploy_id: row.active_deploy_id,
    password_protected: row.password_hash !== null,
    session_ttl_hrs: row.session_ttl_hrs,
  };

  await env.KV.put(kvKey, JSON.stringify(record), { expirationTtl: 60 });
  return record;
}

// ── Session management ────────────────────────────────────────────────────────

async function getValidSession(request: Request, env: Env, site: SiteRecord): Promise<boolean> {
  const cookie = parseCookie(request.headers.get('Cookie') ?? '', '__ph_session');
  if (!cookie) return false;

  const tokenHash = await sha256(cookie);
  const session = await env.KV.get(`session:${site.id}:${tokenHash}`, 'json') as { expires_at: number } | null;
  return session !== null && session.expires_at > Date.now();
}

async function handleLogin(request: Request, env: Env, site: SiteRecord): Promise<Response> {
  // Rate limit login attempts per site+IP to prevent PBKDF2 exhaustion
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const ipHash = await sha256(ip + site.id);
  const window = Math.floor(Date.now() / (900 * 1000)); // 15-min window
  const rateLimitKey = `login_rate:${ipHash}:${window}`;
  const attempts = Number(await env.KV.get(rateLimitKey) ?? '0');
  if (attempts >= 10) {
    return loginPage(site.name, 'Too many attempts. Try again later.', 429);
  }
  await env.KV.put(rateLimitKey, String(attempts + 1), { expirationTtl: 900 });

  const form = await request.formData().catch(() => null);
  const password = form?.get('password');

  if (!password || typeof password !== 'string') {
    return loginPage(site.name, 'Password required.', 400);
  }

  // Fetch actual hash from D1 (not stored in KV)
  const row = await env.DB
    .prepare('SELECT password_hash, session_ttl_hrs FROM sites WHERE id = ?')
    .bind(site.id)
    .first<{ password_hash: string | null; session_ttl_hrs: number }>();

  if (!row?.password_hash) {
    // Site no longer password protected — redirect to content
    return Response.redirect('/', 302);
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    return loginPage(site.name, 'Incorrect password.', 401);
  }

  // On free tier, invalidate any existing session before creating a new one
  // (We approximate free-tier detection by checking session_ttl_hrs — free is fixed at 24)
  const isFree = row.session_ttl_hrs === 24;
  if (isFree) {
    const existing = await env.KV.list({ prefix: `session:${site.id}:`, limit: 10 });
    for (const key of existing.keys) {
      await env.KV.delete(key.name);
    }
  }

  const token = generateToken();
  const tokenHash = await sha256(token);
  const expiresAt = Date.now() + row.session_ttl_hrs * 3600 * 1000;

  await env.KV.put(
    `session:${site.id}:${tokenHash}`,
    JSON.stringify({ created_at: Date.now(), expires_at: expiresAt }),
    { expirationTtl: row.session_ttl_hrs * 3600 },
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/' + site.name,
      'Set-Cookie': `__ph_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/${site.name}`,
      'Cache-Control': 'no-store, no-cache',
    },
  });
}

// ── File serving ──────────────────────────────────────────────────────────────

async function serveFile(env: Env, site: SiteRecord, filePath: string, request: Request): Promise<Response> {
  const prefix = `sites/${site.user_id}/${site.name}/${site.active_deploy_id}`;
  const r2Key = `${prefix}/${filePath}`;
  const object = await env.SITES.get(r2Key, {
    onlyIf: {
      etagMatches: request.headers.get('If-None-Match') ?? undefined,
    },
  });

  if (!object) {
    // Try index.html fallback for SPA routing
    if (filePath !== 'index.html') {
      const fallback = await env.SITES.get(`${prefix}/index.html`);
      if (fallback) {
        return r2ToResponse(fallback, 'text/html; charset=utf-8');
      }
    }
    return notFound(site.name);
  }

  // R2Object without body = etag condition matched → 304 Not Modified
  if (!('body' in object)) {
    return new Response(null, { status: 304, headers: { ETag: object.httpEtag } });
  }

  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
  return r2ToResponse(object, contentType);
}

function r2ToResponse(object: R2ObjectBody, contentType: string): Response {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', contentType);
  headers.set('ETag', object.httpEtag);
  if (object.httpMetadata?.cacheControl) {
    headers.set('Cache-Control', object.httpMetadata.cacheControl);
  } else {
    headers.set('Cache-Control', 'public, max-age=300');
  }
  return new Response(object.body, { headers });
}

// ── Pages ─────────────────────────────────────────────────────────────────────

function loginPage(siteName: string, error: string | null, status = 200): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access required — ${escapeHtml(siteName)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:40px;width:100%;max-width:400px}
    .logo{font-size:13px;font-weight:600;color:#71717a;letter-spacing:.08em;text-transform:uppercase;margin-bottom:32px}
    h1{font-size:22px;font-weight:700;margin-bottom:8px}
    .site{color:#71717a;font-size:14px;margin-bottom:32px;word-break:break-all}
    label{display:block;font-size:13px;font-weight:500;color:#a1a1aa;margin-bottom:8px}
    input{width:100%;background:#09090b;border:1px solid #27272a;border-radius:8px;padding:12px 14px;color:#fafafa;font-size:15px;outline:none;transition:border-color .15s}
    input:focus{border-color:#6366f1}
    .error{background:#1c0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:12px 14px;font-size:13px;color:#fca5a5;margin-top:16px}
    button{width:100%;background:#6366f1;border:none;border-radius:8px;padding:13px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px;transition:background .15s}
    button:hover{background:#4f46e5}
    .footer{text-align:center;font-size:12px;color:#52525b;margin-top:24px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">ItsLive</div>
    <h1>Access required</h1>
    <p class="site">${escapeHtml(siteName)}</p>
    <form method="POST" action="/${escapeHtml(siteName)}/__auth">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autofocus autocomplete="current-password" placeholder="Enter password">
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <button type="submit">Unlock site</button>
    </form>
    <p class="footer">Protected by ItsLive</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache',
    },
  });
}

function notFound(siteName: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>404 — Not found</title>
  <style>body{font-family:-apple-system,sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}h1{font-size:48px;font-weight:800}p{color:#71717a}</style>
</head>
<body><h1>404</h1><p>${escapeHtml(siteName)} not found.</p></body>
</html>`;
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function notDeployed(siteName: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>No content — ${escapeHtml(siteName)}</title>
  <style>body{font-family:-apple-system,sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}h1{font-size:48px;font-weight:800}p{color:#71717a}</style>
</head>
<body><h1>🚧</h1><p>${escapeHtml(siteName)} exists but nothing has been deployed yet.</p></body>
</html>`;
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function gone(siteName: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>410 — Deleted</title>
  <style>body{font-family:-apple-system,sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}h1{font-size:48px;font-weight:800}p{color:#71717a}</style>
</head>
<body><h1>410</h1><p>This site (${escapeHtml(siteName)}) has been deleted.</p></body>
</html>`;
  return new Response(html, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sanitizeFilePath(raw: string): string | null {
  const parts = raw.split('/').filter(Boolean);
  const safe: string[] = [];
  for (const part of parts) {
    if (part === '..') return null;
    if (part === '.') continue;
    safe.push(part);
  }
  return safe.length === 0 ? 'index.html' : safe.join('/');
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k?.trim() === name) return decodeURIComponent(v?.trim() ?? '');
  }
  return null;
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, expectedHash] = stored.split(':');
  if (!saltHex || !expectedHash) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((h: string) => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, keyMaterial, 256);
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time comparison
  const a = new TextEncoder().encode(hash);
  const b = new TextEncoder().encode(expectedHash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
