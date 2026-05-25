import { Hono } from 'hono';
import { z } from 'zod';
import { sha256, generateApiKey, generateOtp, timingSafeEqual } from '../lib/crypto';
import { ulid } from '../lib/id';
import type { Env } from '../types';
import { authMiddleware } from '../middleware/auth';

const router = new Hono<{ Bindings: Env }>();

const SignupSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
});

const VerifySchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  code: z.string().length(6).toUpperCase(),
});

// Same response regardless of outcome (anti-enumeration)
const SIGNUP_RESPONSE = { message: 'Check your email for a verification code.' };
const OTP_TTL = 600; // 10 minutes
const MAX_ATTEMPTS = 5;

router.post('/signup', async c => {
  const body = await c.req.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'EMAIL_INVALID', message: 'Invalid email address.' } }, 400);
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
  const code = generateOtp();

  // Invalidate any previous OTP for this email
  await c.env.KV.delete(`otp:${emailHash}`);
  await c.env.KV.delete(`verify_attempts:${emailHash}`);

  await c.env.KV.put(`otp:${emailHash}`, code, { expirationTtl: OTP_TTL });

  const existing = await c.env.DB
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();

  if (existing) {
    await c.env.QUEUE.send({ type: 'existing_account_notice', email });
  }
  await c.env.QUEUE.send({ type: 'otp_email', email, code });

  return c.json(SIGNUP_RESPONSE, 200);
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
  const attemptsKey = `verify_attempts:${emailHash}`;
  const otpKey = `otp:${emailHash}`;

  const attempts = Number(await c.env.KV.get(attemptsKey) ?? '0');
  if (attempts >= MAX_ATTEMPTS) {
    return c.json({ error: { code: 'CODE_EXPIRED', message: 'Too many attempts. Please request a new code.' } }, 400);
  }

  const stored = await c.env.KV.get(otpKey);
  if (!stored) {
    return c.json({ error: { code: 'CODE_EXPIRED', message: 'Code expired or not found. Please request a new code.' } }, 400);
  }

  if (!timingSafeEqual(stored, code)) {
    await c.env.KV.put(attemptsKey, String(attempts + 1), { expirationTtl: OTP_TTL });
    if (attempts + 1 >= MAX_ATTEMPTS) {
      await c.env.KV.delete(otpKey);
    }
    return c.json({ error: { code: 'CODE_INVALID', message: 'Incorrect verification code.' } }, 400);
  }

  // Success — consume OTP
  await c.env.KV.delete(otpKey);
  await c.env.KV.delete(attemptsKey);

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

  await c.env.DB
    .prepare('UPDATE api_keys SET rotated_at = ? WHERE user_id = ? AND rotated_at IS NULL')
    .bind(now, user.id)
    .run();

  await c.env.DB
    .prepare('INSERT INTO api_keys (id, user_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(keyId, user.id, keyHash, prefix, now)
    .run();

  await c.env.KV.put(`apikey:${keyHash}`, JSON.stringify({ user_id: user.id, plan: user.plan, key_id: keyId }), { expirationTtl: 60 });

  return c.json({ api_key: rawKey, user_id: user.id }, 200);
});

router.post('/keys/rotate', authMiddleware, async c => {
  const { userId, keyId, plan } = c.get('auth');
  const now = Date.now();
  const rawKey = generateApiKey();
  const keyHash = await sha256(rawKey);
  const prefix = rawKey.substring(0, 15);
  const newKeyId = ulid();

  await c.env.DB
    .prepare('UPDATE api_keys SET rotated_at = ? WHERE id = ?')
    .bind(now, keyId)
    .run();

  await c.env.DB
    .prepare('INSERT INTO api_keys (id, user_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newKeyId, userId, keyHash, prefix, now)
    .run();

  await c.env.KV.put(`apikey:${keyHash}`, JSON.stringify({ user_id: userId, plan, key_id: newKeyId }), { expirationTtl: 60 });

  return c.json({ api_key: rawKey, old_key_expires: Math.floor(now / 1000) + 60 }, 200);
});

export default router;
