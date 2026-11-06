import { Hono } from 'hono';
import { z } from 'zod';
import { sha256, generateApiKey, generateOtp, timingSafeEqual } from '../lib/crypto';
import { ulid } from '../lib/id';
import type { Env } from '../types';
import { authMiddleware, invalidateUserKeyCache, ROTATION_GRACE_MS } from '../middleware/auth';

const router = new Hono<{ Bindings: Env }>();

const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

const VerifySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().toUpperCase().length(6),
});

// Same response regardless of outcome (anti-enumeration)
const SIGNUP_RESPONSE = { message: 'Check your email for a verification code.' };
const OTP_TTL = 600; // 10 minutes
const MAX_ATTEMPTS = 5;

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  '10minutemail.net',
  'burnermail.io',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'harakirimail.com',
  'inboxkitten.com',
  'mailcatch.com',
  'maildrop.cc',
  'mailesia.com',
  'mailinator.com',
  'mailnesia.com',
  'mailnull.com',
  'mailsac.com',
  'mohmal.com',
  'mytemp.email',
  'pokemail.net',
  'sharklasers.com',
  'spam4.me',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'tempmail.net',
  'tempmailo.com',
  'throwawaymail.com',
  'tmpmail.net',
  'tmpmail.org',
  'trashmail.com',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
]);

function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true;
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  for (const blocked of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith('.' + blocked)) return true;
  }
  return false;
}

router.post('/signup', async c => {
  const body = await c.req.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success || isDisposableEmail(parsed.data.email)) {
    return c.json({ error: { code: 'EMAIL_INVALID', message: 'Invalid or unsupported email address.' } }, 400);
  }
  const { email } = parsed.data;

  // Per-IP rate limit for signup (prevent bulk account creation)
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipWindow = Math.floor(Date.now() / (600 * 1000));
  const ipKey = `signup_ip:${await sha256(ip)}:${ipWindow}`;
  const ipCount = Number(await c.env.KV.get(ipKey) ?? '0');
  if (ipCount >= 10) {
    return c.json(SIGNUP_RESPONSE, 200); // Silent rate limit — same response
  }
  await c.env.KV.put(ipKey, String(ipCount + 1), { expirationTtl: 600 });

  const emailHash = await sha256(email);

  // Per-email cooldown to prevent spamming someone else's inbox
  const emailCooldownKey = `signup_cooldown:${emailHash}`;
  const recentlySent = await c.env.KV.get(emailCooldownKey);
  if (recentlySent) {
    return c.json(SIGNUP_RESPONSE, 200); // Silent — no email sent
  }
  await c.env.KV.put(emailCooldownKey, '1', { expirationTtl: 120 });

  const code = generateOtp();

  // One live code per email. D1 (not KV) so the attempt counter in /verify is atomic.
  await c.env.DB
    .prepare('INSERT OR REPLACE INTO otp_codes (email_hash, code_hash, attempts, expires_at) VALUES (?, ?, 0, ?)')
    .bind(emailHash, await sha256(code), Date.now() + OTP_TTL * 1000)
    .run();

  const existing = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();

  if (existing) {
    await c.env.QUEUE.send({ type: 'existing_account_notice', email });
  }
  await c.env.QUEUE.send({ type: 'otp_email', email, code });

  // Only an explicit development environment returns the code in the response.
  const isDev = c.env.ENVIRONMENT === 'development';
  return c.json(isDev ? { ...SIGNUP_RESPONSE, dev_code: code } : SIGNUP_RESPONSE, 200);
});

router.post('/verify', async c => {
  // Per-IP rate limit — prevents bulk OTP guessing across accounts with rotating email addresses
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipWindow = Math.floor(Date.now() / (600 * 1000));
  const ipKey = `verify_ip:${await sha256(ip)}:${ipWindow}`;
  const ipCount = Number(await c.env.KV.get(ipKey) ?? '0');
  if (ipCount >= 10) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } }, 429);
  }
  await c.env.KV.put(ipKey, String(ipCount + 1), { expirationTtl: 600 });

  const body = await c.req.json().catch(() => null);
  const parsed = VerifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'CODE_INVALID', message: 'Invalid email or code format.' } }, 400);
  }
  const { email, code } = parsed.data;

  const emailHash = await sha256(email);
  const codeHash = await sha256(code);

  // Count the attempt atomically before comparing, so concurrent guesses cannot exceed MAX_ATTEMPTS.
  const otp = await c.env.DB
    .prepare(
      `UPDATE otp_codes SET attempts = attempts + 1
       WHERE email_hash = ? AND expires_at > ? AND attempts < ?
       RETURNING code_hash`
    )
    .bind(emailHash, Date.now(), MAX_ATTEMPTS)
    .first<{ code_hash: string }>();
  if (!otp) {
    return c.json({ error: { code: 'CODE_EXPIRED', message: 'Code expired, not found, or too many attempts. Please request a new code.' } }, 400);
  }
  if (!timingSafeEqual(otp.code_hash, codeHash)) {
    return c.json({ error: { code: 'CODE_INVALID', message: 'Incorrect verification code.' } }, 400);
  }

  // Consume the code. Only one concurrent request can win the delete.
  const consumed = await c.env.DB
    .prepare('DELETE FROM otp_codes WHERE email_hash = ? AND code_hash = ?')
    .bind(emailHash, codeHash)
    .run();
  if (consumed.meta.changes === 0) {
    return c.json({ error: { code: 'CODE_EXPIRED', message: 'Code already used. Please request a new code.' } }, 400);
  }

  // Upsert user
  let user = await c.env.DB
    .prepare('SELECT id, plan FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; plan: string }>();

  const now = Date.now();
  if (!user) {
    const userId = ulid();
    await c.env.DB
      .prepare('INSERT INTO users (id, email, plan, created_at, verified_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, email, 'free', now, now)
      .run();
    user = { id: userId, plan: 'free' };
    await c.env.QUEUE.send({ type: 'welcome_email', email });
  } else {
    await c.env.DB
      .prepare('UPDATE users SET verified_at = ? WHERE id = ?')
      .bind(now, user.id)
      .run();
  }

  // Rotate key: create new, mark previous as rotated
  const rawKey = generateApiKey();
  const keyHash = await sha256(rawKey);
  const prefix = rawKey.substring(0, 15); // "il_live_" + 7 chars
  const keyId = ulid();

  // Email recovery revokes every existing key immediately, with no grace period.
  const revokedAt = now - ROTATION_GRACE_MS - 1;
  await c.env.DB
    .prepare('UPDATE api_keys SET rotated_at = ? WHERE user_id = ? AND (rotated_at IS NULL OR rotated_at > ?)')
    .bind(revokedAt, user.id, revokedAt)
    .run();
  await invalidateUserKeyCache(c.env, user.id);

  await c.env.DB
    .prepare('INSERT INTO api_keys (id, user_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(keyId, user.id, keyHash, prefix, now)
    .run();

  await c.env.KV.put(`apikey:${keyHash}`, JSON.stringify({ user_id: user.id, plan: user.plan, key_id: keyId }), { expirationTtl: 60 });

  return c.json({ api_key: rawKey, user_id: user.id }, 200);
});

router.post('/keys/rotate', authMiddleware, async c => {
  const { userId, keyId } = c.get('auth');
  const now = Date.now();
  const rawKey = generateApiKey();
  const keyHash = await sha256(rawKey);
  const prefix = rawKey.substring(0, 15);
  const newKeyId = ulid();

  // Only an unrotated key may rotate. A key already in its grace period cannot
  // restart its own grace or mint a successor.
  const [rotated] = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE api_keys SET rotated_at = ? WHERE id = ? AND rotated_at IS NULL').bind(now, keyId),
    c.env.DB
      .prepare(
        `INSERT INTO api_keys (id, user_id, key_hash, prefix, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND rotated_at = ?)`
      )
      .bind(newKeyId, userId, keyHash, prefix, now, keyId, now),
  ]);
  if (rotated.meta.changes === 0) {
    return c.json({ error: { code: 'KEY_ROTATED', message: 'This key has already been rotated. Use your new key.' } }, 401);
  }

  // Drop the old key from the auth cache so its grace period is enforced from D1.
  // The new key is not pre-cached: its first request reads the current plan from D1.
  const oldKey = await c.env.DB.prepare('SELECT key_hash FROM api_keys WHERE id = ?').bind(keyId).first<{ key_hash: string }>();
  if (oldKey) await c.env.KV.delete(`apikey:${oldKey.key_hash}`);

  return c.json({ api_key: rawKey, old_key_expires: Math.floor(now / 1000) + 60 }, 200);
});

export default router;
