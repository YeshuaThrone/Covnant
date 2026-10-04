/**
 * POST /api/covnant/auth/confirmation/resend — re-send the signup
 * confirmation email. The email-verification path's resend control (the
 * founder's active signup verification, directive 2026-10-02), the mirror
 * of the phone OTP routes' transport-only shape: validate, rate-limit, call
 * Supabase, map the outcome to HTTP — the route never sees a token.
 *
 * Supabase call: the anon-key client's auth.resend({ type: 'signup', email })
 * — GoTrue's dedicated resend for unconfirmed signups, anti-enumeration by
 * design: the success shape is identical whether or not the account exists,
 * so the route discloses nothing an email probe could read.
 *
 * Two shared-limiter windows: per-IP (a flood never reaches Supabase Auth)
 * and per-email (one confirmation email per address per minute — every
 * allowed call can spend built-in SMTP quota; the client countdown is
 * cosmetic, the limiter re-rejects early asks).
 *
 * Errors stay fail-closed and sanitized: quota/transport failures are a
 * 503 email_send_failed clean-retry state (never wired around with external
 * SMTP — that needs founder approval), GoTrue's own resend throttle is the
 * 429 resend_cooldown.
 */

import { validateSignupEmail } from '@/lib/covnant/signupValidation';
import {
  checkSharedRateLimit,
  EMAIL_CONFIRMATION_RESEND_RATE_LIMIT,
  EMAIL_CONFIRMATION_COOLDOWN,
} from '@/lib/server/rateLimit';
import { jsonError } from '@/lib/server/http';
import { createAuthClient, readSupabaseEnv } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }

  // The SAME email rule and normalization the signup payload applies —
  // never a forked copy (validateSignupEmail).
  const parsed = validateSignupEmail((body as { email?: unknown }).email);
  if (!parsed.ok) {
    return jsonError(400, 'invalid_email', 'Enter a valid email address.');
  }

  // Per-IP window first, then the per-email cooldown — the flood burns the
  // IP window before it can cycle one address's bucket.
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const ipVerdict = await checkSharedRateLimit(
    `covnant-confirmation-resend-ip:${clientIp}`,
    EMAIL_CONFIRMATION_RESEND_RATE_LIMIT,
  );
  if (!ipVerdict.ok) {
    return jsonError(
      429,
      'rate_limited',
      `Too many requests from this address. Retry after ${ipVerdict.retryAfterSeconds}s.`,
    );
  }
  const emailVerdict = await checkSharedRateLimit(
    `covnant-confirmation-resend-email:${parsed.email}`,
    EMAIL_CONFIRMATION_COOLDOWN,
  );
  if (!emailVerdict.ok) {
    return jsonError(
      429,
      'resend_cooldown',
      `A new confirmation email can be sent in ${emailVerdict.retryAfterSeconds}s.`,
    );
  }

  const env = readSupabaseEnv();
  if (env === null) {
    return jsonError(
      503,
      'supabase_not_configured',
      'Supabase credentials are not configured.',
    );
  }
  const client = createAuthClient(env);

  // Fail-closed against a transport throw too — a rejected Supabase call is
  // the same clean-retry 503, never an unhandled 500.
  let resendError: { message?: string } | null = null;
  try {
    const { error } = await client.auth.resend({
      type: 'signup',
      email: parsed.email,
    });
    resendError = error ?? null;
  } catch (thrown) {
    resendError = {
      message: thrown instanceof Error ? thrown.message : 'transport failure',
    };
  }
  if (resendError !== null) {
    const message = (resendError.message ?? '').toLowerCase();
    if (
      message.includes('rate limit') ||
      message.includes('once every') ||
      message.includes('too many requests')
    ) {
      return jsonError(
        429,
        'resend_cooldown',
        'A new confirmation email was requested too soon — wait a minute and try again.',
      );
    }
    console.error('Confirmation resend failed:', resendError.message);
    return jsonError(
      503,
      'email_send_failed',
      'We could not send the confirmation email right now — try again shortly.',
    );
  }

  // The generic no-enumeration success body — identical shape either way.
  return Response.json(
    { ok: true },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
