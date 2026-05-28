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
  const base = 'https://api.itslive.fyi';
  return c.text(`# ItsLive API — Agent Instructions

Deploy static websites to the public internet with a few API calls.
No OAuth flows. No dashboards. No build step.

Base URL: ${base}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 0 — DO THIS FIRST, EVERY SESSION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Ask the user: "Do you already have an ItsLive API key?"

  YES  → Use it as: X-API-Key: il_live_...  Skip to STEP 2.
  NO   → Follow STEP 1 to get one.
  LOST → Same as NO. The signup+verify flow resets their key.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — GET AN API KEY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Works identically for new accounts and lost-key recovery.

1a. Request a verification code:
    POST /signup
    {"email": "user@example.com"}
    → {"message": "Check your email for a verification code."}

    Dev/test only: response also includes "dev_code": "ABC123".
    Use it directly in step 1c — no email check needed.

1b. Ask the user for the 6-character code from their email.

1c. Exchange code for API key:
    POST /verify
    {"email": "user@example.com", "code": "ABC123"}
    → {"api_key": "il_live_...", "user_id": "..."}

1d. Tell the user to save their key (e.g. .env file or password manager).
    Future sessions: paste it directly, skip verification.
    The key will not be shown again.

Note: /verify always issues a fresh key and marks the previous one rotated.
The old key stays valid for 60 seconds so in-flight requests complete.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — DEPLOY A SITE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2a. Create a site:
    POST /sites
    X-API-Key: il_live_...
    {}
    → 201 {"name": "violet-crane-42", "url": "https://violet-crane-42.itslive.fyi",
           "site_id": "...", "slug_type": "auto", "created_at": "..."}

    Custom name (Builder plan+): {"name": "my-project"}
    Rules: 3–40 chars, lowercase alphanumeric and hyphens only.

2b. Upload content (site goes live immediately on success):
    PUT /sites/{name}
    X-API-Key: il_live_...

    Option A — Single file (raw body):
      Content-Type: text/html         → saved as index.html
      Content-Type: image/gif         → saved as image.gif
      Content-Type: image/png         → saved as image.png
      Content-Type: image/jpeg        → saved as image.jpg
      Content-Type: image/webp        → saved as image.webp
      Content-Type: image/svg+xml     → saved as image.svg
      Content-Type: video/mp4         → saved as video.mp4
      Content-Type: application/pdf   → saved as document.pdf
      <file bytes>

    Option B — ZIP archive:
      Content-Type: application/zip
      <zip bytes>
      Note: index.html required at root only when ZIP contains HTML files.

    Option C — Multipart form:
      Content-Type: multipart/form-data
      <files as form fields>

    → {"url": "...", "deploy_id": "...", "deployed_at": "...",
       "size_bytes": ..., "file_count": ..., "sha256": "..."}

2c. Show the user the live URL.
    For HTML sites: root URL (https://{name}.itslive.fyi/) serves the page.
    For media files: access by direct path (https://{name}.itslive.fyi/image.gif).

To update: repeat step 2b with the same name.
Deploys are atomic — old version stays live until new upload completes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MANAGING SITES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

List sites (includes active, suspended, and deactivated):
  GET /sites
  → {"sites": [{"name", "url", "status", "slug_type",
                "deployed_at", "password_protected"}]}

Site details + last 5 deploys:
  GET /sites/{name}
  → {"name", "url", "status", "slug_type", "created_at", "deployed_at",
     "active_deploy_id", "password_protected", "session_ttl_hrs",
     "deploy_count", "last_5_deploys": [{"deploy_id", "deployed_at",
     "size_bytes", "file_count", "sha256", "status"}]}

Deactivate a site (soft delete — files preserved for 7 days):
  DELETE /sites/{name}
  → {"deactivated": true, "restorable_until": "2025-..."}
  Site returns 404 immediately. Name is held; no one else can register it
  during the restore window.

Restore a deactivated site (must call before restorable_until):
  POST /sites/{name}/restore
  → {"restored": true, "url": "https://{name}.itslive.fyi"}
  After restorable_until passes, files are purged automatically and the name
  enters a 30-day cooling window before it becomes available to anyone.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SITE STATUS LIFECYCLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  active         → serving traffic normally
  suspended      → plan limit exceeded; site returns 402; upgrade plan to restore
  deactivated    → soft-deleted; returns 404; restorable within 7 days
  deleted_cooling → files purged; name held 30 days against squatting; returns 410
  deleted        → fully gone; name available for registration

Transitions:
  active|suspended  →  DELETE            →  deactivated
  deactivated       →  POST /restore      →  active  (within 7 days only)
  deactivated       →  (cron, 7 days)     →  deleted_cooling
  deleted_cooling   →  (cron, 30 days)    →  deleted

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASSWORD PROTECTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Enable:
  PUT /sites/{name}/access
  {"password": "min-8-chars", "session_ttl_hrs": 24}
  session_ttl_hrs max: free=24, builder=168, studio=720. Default: 24.
  → {"password_protected": true, "session_ttl_hrs": 24}
  All existing sessions are revoked immediately.

Disable:
  DELETE /sites/{name}/access
  → {"password_protected": false}

Revoke all sessions (keep password unchanged):
  POST /sites/{name}/access/revoke
  → {"sessions_revoked": 5}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACCOUNT & KEYS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Account info:
  GET /account
  → {"user_id", "email", "plan", "created_at", "api_key_prefix"}

Usage & quotas:
  GET /usage
  → {"plan", "sites": {"used", "limit"}, "storage_bytes": {"used", "limit"},
     "deploys_this_month": {"used", "limit"}, "api_calls_this_hour": {"used", "limit"}}

Rotate key (user has current key, wants a new one):
  POST /keys/rotate
  X-API-Key: il_live_...
  → {"api_key": "il_live_...(new)", "old_key_expires": <unix_seconds>}
  Tell the user to save the new key. Old key valid 60 seconds.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLANS & LIMITS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  free:    3 sites · 5 MB/deploy · 50 deploys/month · 100 API calls/hour · session TTL ≤ 24h
  builder: 25 sites · 25 MB/deploy · 500 deploys/month · 1,000 API calls/hour · session TTL ≤ 168h
  studio:  200 sites · 100 MB/deploy · unlimited deploys · 10,000 API calls/hour · session TTL ≤ 720h

Custom site names: Builder plan or higher.
Suspended and active sites both count toward the site limit.
Deactivated sites do NOT count toward the site limit.

Rate limits (unauthenticated):
  POST /signup: 10/10 min per IP (silently enforced — always returns success)
  POST /verify: 10/10 min per IP · 5 wrong codes locks the OTP
  POST /__auth (login): 10/15 min per IP+site

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR CODES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All errors: {"error": {"code": "...", "message": "..."}}

Auth:
  RATE_LIMITED                  → Wait Retry-After seconds, then retry
  MISSING_KEY                   → Add X-API-Key header
  INVALID_KEY                   → Key wrong or account missing; re-verify (Step 1)
  KEY_IN_URL                    → Move key to header; URL params are rejected
  KEY_ROTATED                   → Key expired after rotation; ask user for current key

OTP:
  CODE_INVALID                  → Wrong code; max 5 attempts before lockout
  CODE_EXPIRED                  → OTP expired or locked; call POST /signup again
  EMAIL_INVALID                 → Check email address format

Sites:
  SITE_NOT_FOUND                → Name wrong, or site is deactivated/purged
  SITE_SUSPENDED                → Plan limit exceeded; upgrade to resume deploys
  ALREADY_DEACTIVATED           → Already soft-deleted; POST /sites/{name}/restore to recover
  SITE_IN_COOLING               → You own this name but it's in its 30-day cooling window
  SITE_NOT_RESTORABLE           → Not found, already purged, or not deactivated

Plan/limits:
  PLAN_LIMIT_REACHED            → Check GET /usage; free: 3 sites, 5 MB, 50 deploys/month
  CUSTOM_SLUG_REQUIRES_PAID_PLAN → Omit "name" from POST /sites to use an auto-generated name
  NAME_TAKEN                    → Name in use or in cooling; choose a different name
  NAME_INVALID                  → 3–40 chars, lowercase alphanumeric + hyphens only
  NAME_RESERVED                 → Choose a different name

Upload:
  FILE_TOO_LARGE                → Reduce total size; free plan limit is 5 MB
  TOO_MANY_FILES                → Max 100 files per deploy
  NO_FILES                      → Request body has no file content
  ENTRYPOINT_MISSING            → Deploy has HTML files but no index.html; add one or use a media-only deploy
  INVALID_ZIP                   → ZIP is corrupt or not a valid archive

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTHENTICATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Header:  X-API-Key: il_live_{key}
Never put the key in a URL — the API rejects it with KEY_IN_URL.
Test environment keys use prefix il_test_ and behave identically.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SITE SERVING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sites served at: https://{name}.itslive.fyi
SPA routing: missing paths fall back to index.html when it exists (HTML sites only)
Cache TTL: 300s default · override per-deploy via X-Cache-TTL header on PUT /sites/{name} (30–86400s)
Site names are permanent — no rename after creation
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
