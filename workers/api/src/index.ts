import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import authRouter from './routes/auth';
import sitesRouter from './routes/sites';
import accountRouter from './routes/account';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-API-Key', 'X-Cache-TTL'],
}));

app.get('/', c => c.json({ name: 'ItsLive API', version: '1.0.0', status: 'ok' }));

app.get('/llms.txt', c => {
  const base = 'https://itslive-api.zasamrat.workers.dev';
  const serveBase = 'https://itslive-serve.zasamrat.workers.dev';
  return c.text(`# ItsLive

Web hosting for AI agents. Zero dashboards. Deploy HTML to the public internet with 3 API calls.

## Base URL
${base}

## Authentication
All authenticated requests require the header:
  X-API-Key: il_live_{key}

Never send the key in query params or request body — the API rejects it with KEY_IN_URL.

## Onboarding (new user)

Step 1: Request a verification code
  POST /signup
  {"email": "user@example.com"}
  → {"message": "Check your email for a verification code."}

Step 2: Verify and receive the API key
  POST /verify
  {"email": "user@example.com", "code": "ABC123"}
  → {"api_key": "il_live_...", "user_id": "..."}

Store the api_key. It will not be shown again.

## Deploy a site

Create site (get a name):
  POST /sites
  X-API-Key: il_live_...
  → {"site_id": "...", "name": "bright-rune-77", "url": "${serveBase}/bright-rune-77", ...}

Deploy HTML (site goes live instantly):
  PUT /sites/{name}
  X-API-Key: il_live_...
  Content-Type: text/html
  <body>Hello world</body>
  → {"url": "...", "deploy_id": "...", "deployed_at": "...", "size_bytes": ...}

Deploy a ZIP archive (multi-file sites):
  PUT /sites/{name}
  X-API-Key: il_live_...
  Content-Type: application/zip
  <zip file bytes — must contain index.html at root>

Deploy multi-file via multipart:
  PUT /sites/{name}
  X-API-Key: il_live_...
  Content-Type: multipart/form-data
  <files as form fields>

## All Endpoints

No auth required:
  POST /signup              {"email": string}
  POST /verify              {"email": string, "code": string}

Auth required:
  POST /keys/rotate         Rotate API key; old key valid 60s
  GET  /account             User info and plan
  GET  /usage               Site count, storage, deploy usage

  POST   /sites             Create site
  GET    /sites             List active sites
  GET    /sites/{name}      Site details + deploy history
  PUT    /sites/{name}      Deploy content (HTML, ZIP, or multipart)
  DELETE /sites/{name}      Delete site (30-day cooling period)

  PUT    /sites/{name}/access        {"password": string, "session_ttl_hrs": number}
  DELETE /sites/{name}/access        Remove password protection
  POST   /sites/{name}/access/revoke Invalidate all active sessions

## Plans
  free:    3 sites, 5 MB/deploy, 50 deploys/month, 100 API calls/hour
  builder: 25 sites, 25 MB/deploy, 500 deploys/month, 1000 API calls/hour
  studio:  200 sites, 100 MB/deploy, unlimited deploys, 10000 API calls/hour

Free plan: auto-generated site names only. Custom names require Builder+.

## Error Format
  {"error": {"code": "RATE_LIMITED", "message": "..."}}

## Error Codes
  MISSING_KEY            No X-API-Key header
  INVALID_KEY            Key not found or invalid
  KEY_IN_URL             Key sent in query param — use header
  KEY_ROTATED            Key was rotated; use new key
  RATE_LIMITED           Rate limit exceeded; see Retry-After header
  PLAN_LIMIT_REACHED     Site/deploy/storage limit for plan
  SITE_NOT_FOUND         Site does not exist or belongs to another user
  NAME_TAKEN             Custom name already in use
  NAME_INVALID           Name must be 3-40 chars, lowercase, alphanumeric + hyphens, no consecutive hyphens
  NAME_RESERVED          Name is on the platform reserved list
  FILE_TOO_LARGE         Deploy exceeds plan size limit
  NO_FILES               No files found in deploy request
  ENTRYPOINT_MISSING     Deploy has no index.html
  INVALID_ZIP            Could not parse ZIP archive
  CODE_INVALID           Wrong OTP
  CODE_EXPIRED           OTP expired or max attempts exceeded

## Rate Limits
  POST /signup: 10 per 10 min per IP
  POST /verify: 10 per 10 min per IP; 5 failed attempts locks the OTP
  Authenticated endpoints: 100–10000 per hour per API key (plan-dependent)

## Site Serving
  Sites served at: ${serveBase}/{site-name}
  SPA routing: requests to missing paths fall back to index.html automatically
  Cache: responses cached at Cloudflare edge for 300s by default
  Custom TTL: set X-Cache-TTL header on PUT /sites/{name} (30–86400 seconds)

## Notes
  - Site names are permanent after creation — no rename in v1
  - Deleted sites enter a 30-day cooling period; URL returns 410 Gone
  - Re-verifying with the same email rotates the API key
  - Deploy is atomic: old version stays live until new upload fully completes
`);
});

// Auth routes: /signup  /verify  /keys/rotate
app.route('/', authRouter);

// Site routes: /sites  /sites/:name  /sites/:name/access  etc.
app.route('/sites', sitesRouter);

// Account routes: /usage  /account
app.route('/', accountRouter);

app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }, 404));

app.onError((err, c) => {
  console.error(err);
  if (err.message === 'SLUG_GENERATION_FAILED') {
    return c.json({ error: { code: 'SLUG_GENERATION_FAILED', message: 'Could not generate a unique site name. Please try again.' } }, 503);
  }
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }, 500);
});

export default app;
