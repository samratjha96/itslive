import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import authRouter from './routes/auth';
import sitesRouter from './routes/sites';
import accountRouter from './routes/account';
import billingRouter from './routes/billing';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-API-Key', 'X-Cache-TTL', 'X-Site-Name'],
}));

app.get('/', c => c.json({ name: 'ItsLive API', version: '1.0.0', status: 'ok', docs: 'https://api.itslive.fyi/llms.txt' }));

app.get('/llms.txt', c => {
  const base = 'https://api.itslive.fyi';
  return c.text(`# ItsLive API — Agent Instructions

Base URL: ${base}
Auth Header: X-API-Key: il_live_... (never in URL query params; test keys use il_test_)

## 1. Onboarding & API Key
Ask the user: "Do you already have an ItsLive API key?"
- YES: use X-API-Key: il_live_... and skip to Section 2.
- NO or LOST:
  1. POST ${base}/signup {"email": "user@example.com"}
     -> {"message": "Check your email for a verification code."} (includes "dev_code" in dev/test)
  2. Ask the user for the 6-character code from their email.
  3. POST ${base}/verify {"email": "user@example.com", "code": "ABC123"}
     -> {"api_key": "il_live_...", "user_id": "..."}
  4. Tell the user to save their key (it is only shown once). Previous keys remain valid for 60s on rotation.

## 2. Create & Deploy a Site
One-step create + deploy (recommended for new sites):
  POST ${base}/sites
  X-API-Key: il_live_...
  - Option A (JSON file map): Content-Type: application/json
    {"name"?: "my-project", "files": {"index.html": "<!doctype html>...", "style.css": "..."}}
  - Option B (single raw file): Content-Type: text/html (index.html), image/png|gif|jpeg|webp|svg+xml, video/mp4, or application/pdf
  - Option C (archive/form): Content-Type: application/zip or multipart/form-data (optional X-Site-Name header for custom name)
  -> 201 {"site_id", "name", "url": "https://{name}.itslive.fyi", "slug_type", "created_at", "deploy_id", "deployed_at", "size_bytes", "file_count", "sha256"}
  (You can also create an empty slot first with POST ${base}/sites {} and deploy via PUT later.)

Update an existing site (atomic deploy):
  PUT ${base}/sites/{name}
  X-API-Key: il_live_...
  Accepts the same payloads (JSON {"files": {...}}, raw file body, ZIP, or multipart).
  Optional header: X-Cache-TTL: 30..86400 (default 300s).
  -> 200 {"url", "deploy_id", "deployed_at", "size_bytes", "file_count", "sha256"}

## 3. Manage Sites & Password Protection
- List sites:       GET ${base}/sites -> {"sites": [{"name", "url", "status", "slug_type", "deployed_at", "password_protected"}]}
- Site details:     GET ${base}/sites/{name} -> site info + last_5_deploys
- Soft delete (7d): DELETE ${base}/sites/{name} -> {"deactivated": true, "restorable_until": "..."} (returns 404 immediately; name held 7d, then 30d cooling)
- Restore site:     POST ${base}/sites/{name}/restore -> {"restored": true, "url": "..."}
- Set password:     PUT ${base}/sites/{name}/access {"password": "min-8-chars", "session_ttl_hrs": 24} (max TTL: free=24h, pro=720h)
- Remove password:  DELETE ${base}/sites/{name}/access
- Revoke sessions:  POST ${base}/sites/{name}/access/revoke -> {"sessions_revoked": n}

## 4. Account, Usage & Pro Upgrade
- Account info:     GET ${base}/account -> {"user_id", "email", "plan", "created_at", "api_key_prefix"}
- Usage & quotas:   GET ${base}/usage -> {"plan", "sites", "storage_bytes", "deploys_this_month", "api_calls_this_hour"}
- Rotate API key:   POST ${base}/keys/rotate -> {"api_key": "il_live_...", "old_key_expires": <unix_secs>}
- Upgrade to Pro ($10 one-time, lifetime):
  * Via API (with X-API-Key): POST ${base}/billing/checkout -> {"checkout_url": "https://checkout.stripe.com/...", "session_id": "..."}
  * Via browser (no key):     GET  ${base}/billing/checkout -> 303 redirect to Stripe Checkout

## 5. Plans & Limits
- free ($0 forever):       3 active sites · 5 MB/deploy · 50 deploys/month · 100 API calls/hour · session TTL <= 24h · auto-generated slugs · noindex
- pro ($10 one-time/life): 500 active sites · 25 MB/deploy · unlimited deploys · 2,000 API calls/hour · session TTL <= 720h · custom names (3-40 lowercase alphanumeric/hyphens) · search indexing enabled

## 6. Error Codes ({"error": {"code": "...", "message": "..."}})
- Auth:   RATE_LIMITED (429), MISSING_KEY (401), INVALID_KEY (401), KEY_IN_URL (401), KEY_ROTATED (401)
- OTP:    EMAIL_INVALID (400), CODE_INVALID (400), CODE_EXPIRED (400)
- Sites:  SITE_NOT_FOUND (404), SITE_SUSPENDED (402), ALREADY_DEACTIVATED (409), SITE_IN_COOLING (409), SITE_NOT_RESTORABLE (404)
- Limits: PLAN_LIMIT_REACHED (402), CUSTOM_SLUG_REQUIRES_PAID_PLAN (402), ALREADY_PRO (409), NAME_TAKEN (409), NAME_INVALID (400), NAME_RESERVED (409)
- Upload: FILE_TOO_LARGE (413), TOO_MANY_FILES (400, max 100), NO_FILES (400), ENTRYPOINT_MISSING (400, index.html required when HTML files present), INVALID_ZIP (400)
`);
});

// Auth routes: /signup  /verify  /keys/rotate
app.route('/', authRouter);

// Site routes: /sites  /sites/:name  /sites/:name/access  etc.
app.route('/sites', sitesRouter);

// Account routes: /usage  /account
app.route('/', accountRouter);

// Billing & Stripe webhook routes: /billing/checkout  /webhooks/stripe
app.route('/', billingRouter);

app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found. See https://api.itslive.fyi/llms.txt' } }, 404));

app.onError((err, c) => {
  console.error(err);
  if (err.message === 'SLUG_GENERATION_FAILED') {
    return c.json({ error: { code: 'SLUG_GENERATION_FAILED', message: 'Could not generate a unique site name. Please try again.' } }, 503);
  }
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } }, 500);
});

export default app;
