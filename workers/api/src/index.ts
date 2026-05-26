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
  return c.text(`# ItsLive API — Agent Instructions

Deploy websites to the public internet with a few API calls.
No OAuth flows. No dashboards. No build step.

Base URL: ${base}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 0 — DO THIS FIRST, EVERY SESSION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Ask the user: "Do you already have an ItsLive API key?"

  YES → Use it immediately as: X-API-Key: il_live_...
        Skip to STEP 2.

  NO  → Follow STEP 1 below to get one.

  LOST → Same as NO. The signup+verify flow resets their key.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — GET AN API KEY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Works for new accounts and lost-key recovery. The flow is identical.

1a. Request a code:
    POST /signup
    {"email": "user@example.com"}
    → {"message": "Check your email for a verification code."}

    Dev/test environments also return "dev_code": "ABC123" in the response.
    Use it directly in 1b — no email needed.

1b. Ask the user for the 6-character code from their email.

1c. Verify and receive the key:
    POST /verify
    {"email": "user@example.com", "code": "ABC123"}
    → {"api_key": "il_live_...", "user_id": "..."}

1d. Tell the user to save their API key somewhere safe (e.g. a .env file or
    password manager). They should paste it into future sessions instead of
    going through verification again. The key will not be shown again.

Returning users: /verify issues a new key and marks the old one rotated.
The old key remains valid for 60 seconds so any in-flight requests complete.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — DEPLOY A SITE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2a. Create a site and get a URL:
    POST /sites
    X-API-Key: il_live_...
    {}
    → 201 {"name": "violet-crane-42", "url": "${serveBase}/violet-crane-42",
           "site_id": "...", "slug_type": "auto", "created_at": "..."}

    Use the "name" from this response in step 2b.

    Custom name (Builder plan+): send {"name": "your-project"} in the body.
    Rules: 3-40 chars, lowercase alphanumeric and hyphens, no consecutive hyphens.

2b. Upload files (site goes live immediately on success):
    PUT /sites/{name}
    X-API-Key: il_live_...

    Single HTML file:
      Content-Type: text/html
      <html content>

    Multi-file site (ZIP — must contain index.html at root):
      Content-Type: application/zip
      <zip bytes>

    Multi-file via multipart:
      Content-Type: multipart/form-data
      <files as form fields>

    → {"url": "...", "deploy_id": "...", "deployed_at": "...",
       "size_bytes": ..., "file_count": ...}

2c. Show the user the "url" from the response. That is their live site.

To update a site: run step 2b again with the same name.
Deploy is atomic — old version stays live until the new upload completes fully.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OTHER OPERATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

List sites:     GET /sites
Site details:   GET /sites/{name}       includes last 5 deploys
Delete site:    DELETE /sites/{name}    30-day cooling; URL returns 410 during cooling
Usage/quotas:   GET /usage             sites used, storage, deploys this month, API calls this hour
Account info:   GET /account

Password-protect a site:
  PUT /sites/{name}/access
  {"password": "secret", "session_ttl_hrs": 24}
  session_ttl_hrs: 1-168 (hours), default 24

Remove protection:   DELETE /sites/{name}/access
Revoke sessions:     POST /sites/{name}/access/revoke

Rotate key (user has current key and wants a new one):
  POST /keys/rotate
  X-API-Key: il_live_...
  → {"api_key": "il_live_...(new)"}
  Tell the user to save the new key. Old key valid 60s.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR HANDLING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All errors: {"error": {"code": "...", "message": "..."}}

What to do for each code:

  RATE_LIMITED                → Wait for Retry-After seconds, then retry
  MISSING_KEY                 → Add X-API-Key header to the request
  INVALID_KEY                 → Key is wrong or account not found; re-verify via email (Step 1)
  KEY_IN_URL                  → Move key to X-API-Key header, never query params
  KEY_ROTATED                 → Ask user for their current key; old one has expired

  CODE_INVALID                → Wrong code; ask user to check email and try again (max 5 attempts)
  CODE_EXPIRED                → OTP expired or locked after 5 failures; call POST /signup again
  EMAIL_INVALID               → Ask user to check their email address

  PLAN_LIMIT_REACHED          → Check GET /usage; free plan allows 3 sites, 5 MB, 50 deploys/month
  CUSTOM_SLUG_REQUIRES_PAID_PLAN → Omit "name" from POST /sites body to use auto-generated name
  NAME_TAKEN                  → Name is in use or cooling; choose a different name
  NAME_INVALID                → Fix: 3-40 chars, lowercase alphanumeric + hyphens, no consecutive hyphens
  NAME_RESERVED               → Choose a different name

  FILE_TOO_LARGE              → Reduce files; free plan limit is 5 MB per deploy
  NO_FILES                    → Check that request body contains file content
  ENTRYPOINT_MISSING          → ZIP must include index.html at the root level
  INVALID_ZIP                 → ZIP file is corrupt or not a valid archive

  SITE_NOT_FOUND              → Confirm site name is correct; use GET /sites to list existing sites

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLANS & LIMITS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  free:    3 sites · 5 MB/deploy · 50 deploys/month · 100 API calls/hour
  builder: 25 sites · 25 MB/deploy · 500 deploys/month · 1,000 API calls/hour
  studio:  200 sites · 100 MB/deploy · unlimited deploys · 10,000 API calls/hour

Custom site names require Builder plan or higher.
All other features are available on the free plan.

Rate limits:
  POST /signup: 10/10 min per IP (silently enforced — success response either way)
  POST /verify: 10/10 min per IP · 5 wrong codes locks the OTP
  Authenticated: see plan limits above

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTHENTICATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Header:  X-API-Key: il_live_{key}
Never put the key in a URL — the API rejects it with KEY_IN_URL.
Test environment keys use the prefix il_test_ and behave identically.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SITE SERVING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sites live at: ${serveBase}/{name}
SPA routing: missing paths fall back to index.html automatically
Cache TTL: 300s default · override with X-Cache-TTL header on PUT /sites/{name} (30–86400s)
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
