import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { sha256, verifyStripeSignature } from '../lib/crypto';
import { ulid } from '../lib/id';
import { applyPlanChange, type Plan } from '../lib/plan';
import type { Env } from '../types';

const router = new Hono<{ Bindings: Env }>();

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const PRO_PRICE_CENTS = '1000'; // $10.00 one-time
const CHECKOUT_LIFETIME_SECS = 1920; // 32 minutes (> Stripe's 30-minute minimum)

async function stripeRequest<T>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string>,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
  };
  let body: string | undefined;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(params ?? {}).toString();
  }
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(`${STRIPE_API_BASE}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json() as T & { error?: { message?: string } };
      if (!resp.ok) {
        if (resp.status >= 500 && attempt === 0 && (method === 'GET' || Boolean(idempotencyKey))) {
          continue;
        }
        throw new Error(data.error?.message ?? `Stripe error ${resp.status}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && (method === 'GET' || Boolean(idempotencyKey))) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

router.post('/billing/checkout', authMiddleware, async c => {
  const { userId } = c.get('auth');
  const secretKey = c.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return c.json({ error: { code: 'BILLING_UNAVAILABLE', message: 'Billing is not configured.' } }, 503);
  }

  const user = await c.env.DB
    .prepare('SELECT id, email, plan, stripe_id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; plan: Plan; stripe_id: string | null }>();

  if (!user) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found.' } }, 404);
  }
  if (user.plan === 'pro') {
    return c.json({ error: { code: 'ALREADY_PRO', message: 'Account is already on the Pro plan.' } }, 409);
  }

  const nowSecs = Math.floor(Date.now() / 1000);

  const existing = await c.env.DB
    .prepare('SELECT attempt_id, session_id, checkout_url, expires_at FROM billing_checkouts WHERE user_id = ?')
    .bind(user.id)
    .first<{ attempt_id: string; session_id: string | null; checkout_url: string | null; expires_at: number }>();

  if (existing && existing.expires_at > nowSecs && existing.session_id && existing.checkout_url) {
    const liveStatus = await getStripeSessionStatus(secretKey, existing.session_id);
    if (liveStatus === 'open') {
      return c.json({ checkout_url: existing.checkout_url, session_id: existing.session_id });
    }
    await c.env.DB.prepare('DELETE FROM billing_checkouts WHERE user_id = ?').bind(user.id).run();
    if (liveStatus === 'paid') {
      await applyPlanChange(c.env, user.id, 'pro');
      return c.json({ error: { code: 'ALREADY_PRO', message: 'Account is already on the Pro plan.' } }, 409);
    }
  }

  // Reserve or reuse an unexpired pending attempt so concurrent callers share
  // the exact same attempt_id and expires_at for Stripe's Idempotency-Key.
  const freshAttemptId = ulid();
  const freshExpiresAt = nowSecs + CHECKOUT_LIFETIME_SECS;

  await c.env.DB
    .prepare(
      `INSERT INTO billing_checkouts (user_id, attempt_id, session_id, checkout_url, expires_at, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         attempt_id = CASE WHEN billing_checkouts.expires_at <= ? THEN excluded.attempt_id ELSE billing_checkouts.attempt_id END,
         session_id = CASE WHEN billing_checkouts.expires_at <= ? THEN NULL ELSE billing_checkouts.session_id END,
         checkout_url = CASE WHEN billing_checkouts.expires_at <= ? THEN NULL ELSE billing_checkouts.checkout_url END,
         expires_at = CASE WHEN billing_checkouts.expires_at <= ? THEN excluded.expires_at ELSE billing_checkouts.expires_at END,
         created_at = CASE WHEN billing_checkouts.expires_at <= ? THEN excluded.created_at ELSE billing_checkouts.created_at END`
    )
    .bind(
      user.id,
      freshAttemptId,
      freshExpiresAt,
      Date.now(),
      nowSecs,
      nowSecs,
      nowSecs,
      nowSecs,
      nowSecs,
    )
    .run();

  const activeAttempt = await c.env.DB
    .prepare('SELECT attempt_id, session_id, checkout_url, expires_at FROM billing_checkouts WHERE user_id = ?')
    .bind(user.id)
    .first<{ attempt_id: string; session_id: string | null; checkout_url: string | null; expires_at: number }>();

  if (!activeAttempt) {
    throw new Error('Failed to reserve checkout attempt');
  }
  if (activeAttempt.session_id && activeAttempt.checkout_url) {
    return c.json({ checkout_url: activeAttempt.checkout_url, session_id: activeAttempt.session_id });
  }

  const baseUrl = `https://${c.env.SERVE_DOMAIN}`;
  const params: Record<string, string> = {
    mode: 'payment',
    allow_promotion_codes: 'true',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': PRO_PRICE_CENTS,
    'line_items[0][price_data][product_data][name]': 'ItsLive Pro (Lifetime)',
    'line_items[0][price_data][product_data][description]': '500 sites, 25 MB per deploy, custom site names, unlimited deploys',
    'line_items[0][quantity]': '1',
    client_reference_id: user.id,
    'metadata[user_id]': user.id,
    'payment_intent_data[metadata][user_id]': user.id,
    expires_at: String(activeAttempt.expires_at),
    success_url: `${baseUrl}/?upgraded=1`,
    cancel_url: `${baseUrl}/`,
  };

  if (user.stripe_id) {
    params.customer = user.stripe_id;
  } else {
    params.customer_email = user.email;
    params.customer_creation = 'always';
  }

  const session = await stripeRequest<{ id: string; url: string }>(
    secretKey,
    'POST',
    '/checkout/sessions',
    params,
    `pro_checkout:${activeAttempt.attempt_id}`,
  );

  await c.env.DB
    .prepare('UPDATE billing_checkouts SET session_id = ?, checkout_url = ? WHERE user_id = ? AND attempt_id = ?')
    .bind(session.id, session.url, user.id, activeAttempt.attempt_id)
    .run();

  return c.json({ checkout_url: session.url, session_id: session.id });
});

router.get('/billing/checkout', async c => {
  const secretKey = c.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return c.json({ error: { code: 'BILLING_UNAVAILABLE', message: 'Billing is not configured.' } }, 503);
  }

  // Per-IP rate limit (20 checkouts / 10 min)
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipWindow = Math.floor(Date.now() / (600 * 1000));
  const ipKey = `web_checkout_ip:${await sha256(ip)}:${ipWindow}`;
  const ipCount = Number(await c.env.KV.get(ipKey) ?? '0');
  if (ipCount >= 20) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many checkout attempts. Try again later.' } }, 429);
  }
  await c.env.KV.put(ipKey, String(ipCount + 1), { expirationTtl: 600 });

  const baseUrl = `https://${c.env.SERVE_DOMAIN}`;
  const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECS;
  const params: Record<string, string> = {
    mode: 'payment',
    allow_promotion_codes: 'true',
    customer_creation: 'always',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': PRO_PRICE_CENTS,
    'line_items[0][price_data][product_data][name]': 'ItsLive Pro (Lifetime)',
    'line_items[0][price_data][product_data][description]': '500 sites, 25 MB per deploy, custom site names, unlimited deploys',
    'line_items[0][quantity]': '1',
    expires_at: String(expiresAt),
    success_url: `${baseUrl}/?upgraded=1`,
    cancel_url: `${baseUrl}/#pricing`,
  };

  const session = await stripeRequest<{ id: string; url: string }>(
    secretKey,
    'POST',
    '/checkout/sessions',
    params,
    `web_checkout:${ulid()}`,
  );
  return c.redirect(session.url, 303);
});

interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: {
      id?: string;
      customer?: string | null;
      customer_email?: string | null;
      customer_details?: { email?: string | null } | null;
      client_reference_id?: string | null;
      payment_intent?: string | null;
      payment_status?: string;
      refunded?: boolean;
      amount?: number;
      amount_refunded?: number;
      status?: string;
      metadata?: { user_id?: string };
    };
  };
}

router.post('/webhooks/stripe', async c => {
  const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return c.json({ error: { code: 'BILLING_UNAVAILABLE', message: 'Webhook secret not configured.' } }, 503);
  }

  const sigHeader = c.req.header('Stripe-Signature');
  if (!sigHeader) {
    return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Missing Stripe-Signature header.' } }, 400);
  }

  const rawBody = await c.req.text();
  const valid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!valid) {
    return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid Stripe webhook signature.' } }, 400);
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(rawBody) as StripeWebhookEvent;
  } catch {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Invalid JSON payload.' } }, 400);
  }

  if (!event?.id || !event?.type || !event?.data?.object) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Malformed Stripe event.' } }, 400);
  }

  // Check if event was already processed; only insert into stripe_webhook_events
  // AFTER all fulfillment queries succeed so transient D1 errors remain retryable.
  const alreadyProcessed = await c.env.DB
    .prepare('SELECT event_id FROM stripe_webhook_events WHERE event_id = ?')
    .bind(event.id)
    .first<{ event_id: string }>();
  if (alreadyProcessed) {
    return c.json({ received: true, duplicate: true });
  }

  const obj = event.data.object;
  const customerId = typeof obj.customer === 'string' ? obj.customer : null;
  const paymentIntentId = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
  const metadataUserId = obj.metadata?.user_id ?? obj.client_reference_id ?? null;
  const checkoutEmail = (obj.customer_details?.email ?? obj.customer_email ?? null)?.trim().toLowerCase() ?? null;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (event.type === 'checkout.session.completed' && obj.payment_status !== 'paid') {
        break;
      }
      const userId = await resolveOrCreateWebhookUser(c.env, metadataUserId, customerId, paymentIntentId, checkoutEmail);
      if (!userId) break;

      const piKey = paymentIntentId ?? obj.id ?? event.id;
      const now = Date.now();

      await c.env.DB
        .prepare(
          `INSERT INTO billing_purchases (payment_intent_id, user_id, session_id, customer_id, paid, refunded, dispute_status, updated_at)
           VALUES (?, ?, ?, ?, 1, 0, 'none', ?)
           ON CONFLICT(payment_intent_id) DO UPDATE SET
             user_id = COALESCE(billing_purchases.user_id, excluded.user_id),
             session_id = COALESCE(excluded.session_id, billing_purchases.session_id),
             customer_id = COALESCE(excluded.customer_id, billing_purchases.customer_id),
             paid = 1,
             updated_at = excluded.updated_at`
        )
        .bind(piKey, userId, obj.id ?? null, customerId, now)
        .run();

      if (customerId) {
        await c.env.DB
          .prepare('UPDATE users SET stripe_id = ? WHERE id = ?')
          .bind(customerId, userId)
          .run();
      }
      await c.env.DB
        .prepare('DELETE FROM billing_checkouts WHERE user_id = ?')
        .bind(userId)
        .run();
      await expireOpenCustomerSessions(c.env.STRIPE_SECRET_KEY, customerId, obj.id ?? null);
      await reconcileUserEntitlement(c.env, userId);
      break;
    }

    case 'checkout.session.expired': {
      const userId = await resolveWebhookUserId(c.env, metadataUserId, customerId, paymentIntentId);
      if (obj.id) {
        await c.env.DB
          .prepare('DELETE FROM billing_checkouts WHERE session_id = ?')
          .bind(obj.id)
          .run();
      } else if (userId) {
        await c.env.DB
          .prepare('DELETE FROM billing_checkouts WHERE user_id = ?')
          .bind(userId)
          .run();
      }
      break;
    }

    case 'charge.refunded': {
      const isFullRefund = obj.refunded === true || (
        typeof obj.amount === 'number' &&
        typeof obj.amount_refunded === 'number' &&
        obj.amount > 0 &&
        obj.amount_refunded >= obj.amount
      );
      if (!isFullRefund) break;

      const userId = await resolveWebhookUserId(c.env, metadataUserId, customerId, paymentIntentId);
      const piKey = paymentIntentId ?? obj.id ?? event.id;

      await c.env.DB
        .prepare(
          `INSERT INTO billing_purchases (payment_intent_id, user_id, session_id, customer_id, paid, refunded, dispute_status, updated_at)
           VALUES (?, ?, NULL, ?, 0, 1, 'none', ?)
           ON CONFLICT(payment_intent_id) DO UPDATE SET
             user_id = COALESCE(billing_purchases.user_id, excluded.user_id),
             customer_id = COALESCE(excluded.customer_id, billing_purchases.customer_id),
             refunded = 1,
             updated_at = excluded.updated_at`
        )
        .bind(piKey, userId, customerId, Date.now())
        .run();

      const resolvedUserId = userId ?? await getPurchaseUserId(c.env, piKey);
      if (resolvedUserId) {
        await reconcileUserEntitlement(c.env, resolvedUserId);
      }
      break;
    }

    case 'charge.dispute.created': {
      const userId = await resolveWebhookUserId(c.env, metadataUserId, customerId, paymentIntentId);
      const piKey = paymentIntentId ?? obj.id ?? event.id;

      // Do not overwrite 'won' or 'lost' if charge.dispute.closed arrived before charge.dispute.created
      await c.env.DB
        .prepare(
          `INSERT INTO billing_purchases (payment_intent_id, user_id, session_id, customer_id, paid, refunded, dispute_status, updated_at)
           VALUES (?, ?, NULL, ?, 0, 0, 'open', ?)
           ON CONFLICT(payment_intent_id) DO UPDATE SET
             user_id = COALESCE(billing_purchases.user_id, excluded.user_id),
             customer_id = COALESCE(excluded.customer_id, billing_purchases.customer_id),
             dispute_status = CASE WHEN billing_purchases.dispute_status = 'none' THEN 'open' ELSE billing_purchases.dispute_status END,
             updated_at = excluded.updated_at`
        )
        .bind(piKey, userId, customerId, Date.now())
        .run();

      const resolvedUserId = userId ?? await getPurchaseUserId(c.env, piKey);
      if (resolvedUserId) {
        await reconcileUserEntitlement(c.env, resolvedUserId);
      }
      break;
    }

    case 'charge.dispute.closed': {
      const userId = await resolveWebhookUserId(c.env, metadataUserId, customerId, paymentIntentId);
      const piKey = paymentIntentId ?? obj.id ?? event.id;
      const disputeStatus = obj.status === 'won' ? 'won' : 'lost';

      await c.env.DB
        .prepare(
          `INSERT INTO billing_purchases (payment_intent_id, user_id, session_id, customer_id, paid, refunded, dispute_status, updated_at)
           VALUES (?, ?, NULL, ?, 0, 0, ?, ?)
           ON CONFLICT(payment_intent_id) DO UPDATE SET
             user_id = COALESCE(billing_purchases.user_id, excluded.user_id),
             customer_id = COALESCE(excluded.customer_id, billing_purchases.customer_id),
             dispute_status = excluded.dispute_status,
             updated_at = excluded.updated_at`
        )
        .bind(piKey, userId, customerId, disputeStatus, Date.now())
        .run();

      const resolvedUserId = userId ?? await getPurchaseUserId(c.env, piKey);
      if (resolvedUserId) {
        await reconcileUserEntitlement(c.env, resolvedUserId);
      }
      break;
    }
  }

  await c.env.DB
    .prepare('INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, processed_at) VALUES (?, ?, ?)')
    .bind(event.id, event.type, Date.now())
    .run();

  return c.json({ received: true });
});

async function getStripeSessionStatus(secretKey: string, sessionId: string): Promise<'open' | 'paid' | 'closed'> {
  try {
    const s = await stripeRequest<{ status?: string; payment_status?: string }>(
      secretKey,
      'GET',
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (s.payment_status === 'paid') return 'paid';
    if (s.status === 'open') return 'open';
    return 'closed';
  } catch {
    // On transient network error, assume cached session is still usable
    return 'open';
  }
}

// Best-effort cleanup: when a purchase succeeds, expire any other still-open
// Checkout sessions for the same Stripe customer so a second open tab cannot pay twice.
async function expireOpenCustomerSessions(
  secretKey: string | undefined,
  customerId: string | null,
  completedSessionId: string | null,
): Promise<void> {
  if (!secretKey || !customerId) return;
  try {
    const list = await stripeRequest<{ data?: { id: string; status?: string }[] }>(
      secretKey,
      'GET',
      `/checkout/sessions?customer=${encodeURIComponent(customerId)}&status=open&limit=10`,
    );
    const others = (list.data ?? []).filter(s => s.id && s.id !== completedSessionId && s.status === 'open');
    await Promise.all(
      others.map(s =>
        stripeRequest(secretKey, 'POST', `/checkout/sessions/${encodeURIComponent(s.id)}/expire`, {}, `expire:${s.id}`).catch(() => {}),
      ),
    );
  } catch (err) {
    console.warn(`billing: failed to expire open sessions for customer ${customerId}:`, err);
  }
}

async function getPurchaseUserId(env: Env, piKey: string): Promise<string | null> {
  const row = await env.DB
    .prepare('SELECT user_id FROM billing_purchases WHERE payment_intent_id = ?')
    .bind(piKey)
    .first<{ user_id: string | null }>();
  return row?.user_id ?? null;
}

// Recomputes user's effective plan and site statuses atomically from billing_purchases.
async function reconcileUserEntitlement(env: Env, userId: string): Promise<void> {
  await applyPlanChange(env, userId);
}

async function resolveOrCreateWebhookUser(
  env: Env,
  metadataUserId: string | null,
  customerId: string | null,
  paymentIntentId: string | null,
  email: string | null,
): Promise<string | null> {
  const existingId = await resolveWebhookUserId(env, metadataUserId, customerId, paymentIntentId);
  if (existingId) return existingId;

  if (!email) return null;

  const byEmail = await env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (byEmail?.id) return byEmail.id;

  const newUserId = ulid();
  const now = Date.now();
  await env.DB
    .prepare('INSERT OR IGNORE INTO users (id, email, plan, created_at, stripe_id) VALUES (?, ?, ?, ?, ?)')
    .bind(newUserId, email, 'pro', now, customerId)
    .run();

  const created = await env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  return created?.id ?? null;
}

async function resolveWebhookUserId(
  env: Env,
  metadataUserId: string | null,
  customerId: string | null,
  paymentIntentId: string | null,
): Promise<string | null> {
  if (paymentIntentId) {
    const purchase = await env.DB
      .prepare('SELECT user_id FROM billing_purchases WHERE payment_intent_id = ?')
      .bind(paymentIntentId)
      .first<{ user_id: string | null }>();
    if (purchase?.user_id) return purchase.user_id;
  }

  if (metadataUserId) {
    const user = await env.DB
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(metadataUserId)
      .first<{ id: string }>();
    if (user?.id) return user.id;
  }

  if (customerId) {
    const row = await env.DB
      .prepare('SELECT id FROM users WHERE stripe_id = ?')
      .bind(customerId)
      .first<{ id: string }>();
    if (row?.id) return row.id;
  }

  return null;
}

export default router;
