interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SITES: R2Bucket;
  RESEND_API_KEY: string;
}

type QueueMessage =
  | { type: 'otp_email'; email: string; code: string }
  | { type: 'welcome_email'; email: string }
  | { type: 'existing_account_notice'; email: string }
  | { type: 'post_deploy_cache_purge'; site_name: string }
  | { type: 'site_delete_cleanup'; site_id: string; user_id: string; site_name: string };

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const body = msg.body as QueueMessage;
      try {
        switch (body.type) {
          case 'otp_email':
            await sendOtp(env, body.email, body.code);
            break;
          case 'welcome_email':
            await sendWelcome(env, body.email);
            break;
          case 'existing_account_notice':
            await sendExistingAccountNotice(env, body.email);
            break;
          case 'post_deploy_cache_purge':
            await env.KV.delete(`site:${body.site_name}`);
            break;
          case 'site_delete_cleanup':
            await deleteSiteFiles(env, body.user_id, body.site_name);
            break;
          default:
            // Unknown type — dead-letter, never execute
            console.error('Unknown queue message type:', (body as { type: string }).type);
            msg.retry();
            continue;
        }
        msg.ack();
      } catch (err) {
        console.error(`Queue job failed [${body.type}]:`, err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

// ── R2 site cleanup ───────────────────────────────────────────────────────────

async function deleteSiteFiles(env: Env, userId: string, siteName: string): Promise<void> {
  if (!userId || !siteName) {
    // Guard: never delete without a scoped prefix
    throw new Error(`Cannot delete site files: userId=${userId} siteName=${siteName}`);
  }

  const prefix = `sites/${userId}/${siteName}/`;
  let cursor: string | undefined;

  do {
    const list = await env.SITES.list({ prefix, limit: 1000, cursor });

    if (list.objects.length > 0) {
      const keys = list.objects.map(o => o.key);
      await env.SITES.delete(keys);
    }

    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  // Verify site is marked deleted in D1 before returning
  const site = await env.DB
    .prepare("SELECT status FROM sites WHERE id = (SELECT id FROM sites WHERE user_id = ? AND name = ? LIMIT 1)")
    .bind(userId, siteName)
    .first<{ status: string }>();

  if (site && site.status !== 'deleted_cooling' && site.status !== 'deleted') {
    console.warn(`Unexpected site status after delete cleanup: ${site.status}`);
  }
}

// ── Resend email ──────────────────────────────────────────────────────────────

const FROM = 'ItsLive <noreply@itslive.dev>';
const RESEND_API = 'https://api.resend.com/emails';

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend ${resp.status}: ${text}`);
  }
}

async function sendOtp(env: Env, email: string, code: string): Promise<void> {
  await sendEmail(env, email, 'Your ItsLive verification code', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Verify your email</h1>
      <p style="color:#666;margin-bottom:32px">Enter this code to complete your ItsLive sign-up:</p>
      <div style="background:#f4f4f5;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px">
        <span style="font-size:40px;font-weight:700;letter-spacing:8px;font-family:monospace">${code}</span>
      </div>
      <p style="color:#999;font-size:14px">Expires in 10 minutes. One use only.</p>
    </div>`);
}

async function sendWelcome(env: Env, email: string): Promise<void> {
  await sendEmail(env, email, 'Welcome to ItsLive', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">You're live.</h1>
      <p style="color:#666">Your API key has been issued. Deploy your first site in seconds.</p>
    </div>`);
}

async function sendExistingAccountNotice(env: Env, email: string): Promise<void> {
  await sendEmail(env, email, 'ItsLive account activity', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Sign-up attempt notice</h1>
      <p style="color:#666">Someone tried to create an ItsLive account with your email.</p>
      <p style="color:#666;margin-top:16px">If this was you, check for a separate verification code. If not, no action needed.</p>
    </div>`);
}
