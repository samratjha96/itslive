# ItsLive

**Deploy a website with two API calls.**

No dashboards. No OAuth. No build pipeline. No configuration.  
POST your HTML. Get a live URL back. Done.

→ **[itslive.fyi](https://itslive-serve.zasamrat.workers.dev)**

---

## The problem

Getting something live is broken.

You need a platform account, a dashboard, a domain, DNS records, a build tool, environment variables, CI/CD config, and a deployment pipeline — just to share an HTML file with someone.

AI agents that generate UIs hit this wall constantly. They can build the frontend. They can't show it to anyone.

ItsLive fixes that.

---

## How it works

```bash
# 1. Get an API key (one-time)
curl -X POST https://itslive-api.zasamrat.workers.dev/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
# → Check your email for a 6-character code

curl -X POST https://itslive-api.zasamrat.workers.dev/verify \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "code": "ABC123"}'
# → {"api_key": "il_live_..."}

# 2. Create a site
curl -X POST https://itslive-api.zasamrat.workers.dev/sites \
  -H "X-API-Key: il_live_..." \
  -H "Content-Type: application/json" \
  -d '{}'
# → {"name": "violet-crane-42", "url": "https://.../violet-crane-42"}

# 3. Deploy
curl -X PUT https://itslive-api.zasamrat.workers.dev/sites/violet-crane-42 \
  -H "X-API-Key: il_live_..." \
  -H "Content-Type: text/html" \
  --data-binary @index.html
# → Site is live.
```

**Idea to live URL in under a minute.**

---

## Built for AI agents

ItsLive ships a machine-readable [`llms.txt`](https://itslive-api.zasamrat.workers.dev/llms.txt) — a structured instruction file any LLM can follow to create, deploy, and manage sites end to end, without human intervention on the deploy step.

Ask Claude or ChatGPT to "deploy this using itslive.fyi" and it handles the whole flow autonomously.

---

## Features

- **Instant deploys** — from API call to live URL in seconds, served globally
- **Multi-file support** — upload a ZIP archive or multipart form; `index.html` at root goes live immediately
- **Atomic deploys** — old version stays live until the new upload completes fully
- **SPA routing** — missing paths fall back to `index.html` automatically
- **Password protection** — lock any site behind a password; revoke sessions via API
- **Key rotation** — rotate your API key; old key stays valid for 60 seconds so in-flight requests complete
- **Global CDN** — served from 200+ Cloudflare locations worldwide; Tokyo loads as fast as New York
- **Free to start** — 3 sites, no credit card required

---

## Plans

|  | Free | Builder | Studio |
|--|------|---------|--------|
| Sites | 3 | 25 | 200 |
| Max deploy size | 5 MB | 25 MB | 100 MB |
| Deploys / month | 50 | 500 | Unlimited |
| API calls / hour | 100 | 1,000 | 10,000 |
| Custom site names | — | ✓ | ✓ |

---

## API reference

Full agent-executable instructions at [`/llms.txt`](https://itslive-api.zasamrat.workers.dev/llms.txt).

**Base URL:** `https://itslive-api.zasamrat.workers.dev`

**Auth:** `X-API-Key: il_live_...` header on every authenticated request. Never in query params.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/signup` | — | Request a verification code |
| `POST` | `/verify` | — | Verify code, receive API key |
| `POST` | `/keys/rotate` | ✓ | Rotate API key (old key valid 60s) |
| `GET` | `/sites` | ✓ | List your sites |
| `POST` | `/sites` | ✓ | Create a site |
| `GET` | `/sites/:name` | ✓ | Site details + last 5 deploys |
| `PUT` | `/sites/:name` | ✓ | Deploy files (HTML, ZIP, multipart) |
| `DELETE` | `/sites/:name` | ✓ | Delete site (30-day cooling period) |
| `PUT` | `/sites/:name/access` | ✓ | Enable password protection |
| `DELETE` | `/sites/:name/access` | ✓ | Remove password protection |
| `POST` | `/sites/:name/access/revoke` | ✓ | Revoke all active sessions |
| `GET` | `/usage` | ✓ | Usage and quota |
| `GET` | `/account` | ✓ | Account details |

### Deploy formats

```bash
# Single HTML file
curl -X PUT .../sites/my-site \
  -H "X-API-Key: ..." \
  -H "Content-Type: text/html" \
  --data-binary @index.html

# ZIP archive (must contain index.html at root)
curl -X PUT .../sites/my-site \
  -H "X-API-Key: ..." \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip

# Custom cache TTL (30–86400 seconds)
curl -X PUT .../sites/my-site \
  -H "X-API-Key: ..." \
  -H "X-Cache-TTL: 3600" \
  -H "Content-Type: text/html" \
  --data-binary @index.html
```

### Error format

All errors return `{"error": {"code": "...", "message": "..."}}`.

Notable codes: `RATE_LIMITED`, `INVALID_KEY`, `PLAN_LIMIT_REACHED`, `ENTRYPOINT_MISSING`, `NAME_TAKEN`.

---

## Stack

Cloudflare Workers · D1 (SQLite) · KV · R2 · Queues · Resend
