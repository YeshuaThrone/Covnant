/**
 * POST /api/covnant/auth/phone/otp — request a 6-digit phone verification
 * code (the signup OTP step's "send" and "Resend" both hit this route).
 *
 * Contract (spec art_pd8VlEMI):
 * - The account already exists (the signup 201 precedes any OTP step) — this
 *   route can only enrich it. It never creates or blocks anything.
 * - The { email, phone } pair must match an EXISTING creator_profiles row:
 *   same canonical E.164 phone, still unverified. Any other case — unknown
 *   email, mismatched phone, already-verified — returns the SAME generic
 *   success envelope as a real send. No account enumeration: the response
 *   never distinguishes "sent" from "not eligible".
 * - 60-second resend cooldown, enforced server-side from the latest
 *   phone_verifications row (the UI's disabled Resend is cosmetic only).
 *   A request for an unknown profile skips the cooldown check entirely —
 *   indistinguishable from the generic path.
 * - Requesting a new code CONSUMES prior unexpired rows (expired_by_resend)
 *   so exactly one live code exists per profile at any moment.
 * - Delivery is best-effort and fail-open: a provider that throws, times
 *   out, or reports failure still returns 200 — with delivered: false. No
 *   delivery outage may ever surface as an HTTP error wall; the UI's skip
 *   path covers everyone.
 * - The code NEVER appears in any response body. The none provider logs it
 *   server-side (dev / pre-Textbee state by design).
 * - Env is fail-closed 503: no Supabase credentials or no OTP_HASH_SECRET
 *   means no code is ever generated or stored.
 *
 * Rate limiting is the shared Postgres-backed limiter (per-IP window here;
 * the per-phone half is the cooldown above) — one of the tightest windows
 * in the app because every allowed call can spend a real SMS.
 */

import {
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  buildOtpMessage,
  generateOtp,
  hashOtp,
} from '@/lib/covnant/otp/service';
import { normalizeOtpEmail } from '@/lib/covnant/otp/input';
import { normalizeOptionalE164 } from '@/lib/covnant/signupValidation';
import { getSmsProvider } from '@/lib/covnant/otp/smsProvider';
import { jsonError } from '@/lib/server/http';
import { checkSharedRateLimit, PHONE_OTP_REQUEST_RATE_LIMIT } from '@/lib/server/rateLimit';
import { createAdminClient, readSupabaseEnv } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/** The creator_profiles fields the OTP flow reads. */
interface ProfileRow {
  id: string;
  phone: string | null;
  phone_verified_at: string | null;
}

/** The phone_verifications fields the cooldown check reads. */
interface LatestVerificationRow {
  created_at: string;
}

/** The generic no-enumeration success body — identical shape either way. */
function genericSuccess(delivered: boolean): Response {
  return Response.json(
    { ok: true, delivered },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

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

  const { email: rawEmail, phone: rawPhone } = body as { email?: unknown; phone?: unknown };
  const email = normalizeOtpEmail(rawEmail);
  if (email === null) {
    return jsonError(400, 'invalid_email', 'Enter a valid email address.');
  }
  const phoneResult = normalizeOptionalE164(rawPhone);
  if (!phoneResult.ok || phoneResult.phone === null) {
    return jsonError(400, 'invalid_phone', "That phone number doesn't look right — enter a real number, any format works.");
  }
  const phone = phoneResult.phone;

  // Shared Postgres-backed limiter (per-IP window) — after validation, so a
  // malformed body never burns the bucket (the signup route's order).
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const verdict = await checkSharedRateLimit(`covnant-otp-request:${clientIp}`, PHONE_OTP_REQUEST_RATE_LIMIT);
  if (!verdict.ok) {
    return jsonError(429, 'rate_limited', 'Too many code requests from this address. Try again later.');
  }

  // Fail-closed configuration — a missing secret must never yield a code.
  const env = readSupabaseEnv();
  if (env === null) {
    return jsonError(503, 'supabase_not_configured', 'Phone verification is not configured.');
  }
  const otpHashSecret = process.env.OTP_HASH_SECRET;
  if (!otpHashSecret) {
    return jsonError(503, 'otp_not_configured', 'Phone verification is not configured.');
  }
  const admin = createAdminClient(env);

  // Eligibility: the profile must exist, carry the SAME canonical phone, and
  // still be unverified. Every ineligible case falls through to the same
  // generic success as a real send — the response is not an oracle.
  const profileQuery = await admin
    .from('creator_profiles')
    .select('id, phone, phone_verified_at')
    .eq('email', email)
    .maybeSingle<ProfileRow>();
  if (profileQuery.error) {
    console.error('Phone OTP request failed to read creator_profiles:', profileQuery.error.message);
    return jsonError(500, 'otp_request_failed', 'Phone verification could not be requested.');
  }
  const profile = profileQuery.data;
  if (profile === null || profile.phone !== phone || profile.phone_verified_at !== null) {
    return genericSuccess(false);
  }

  // Server-enforced resend cooldown: 60s since the profile's latest row was
  // created, whatever the client's Resend button claims.
  const latestQuery = await admin
    .from('phone_verifications')
    .select('created_at')
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<LatestVerificationRow>();
  if (latestQuery.error) {
    console.error('Phone OTP request failed to read phone_verifications:', latestQuery.error.message);
    return jsonError(500, 'otp_request_failed', 'Phone verification could not be requested.');
  }
  const nowMs = Date.now();
  const latest = latestQuery.data;
  if (latest !== null) {
    const elapsedMs = nowMs - new Date(latest.created_at).getTime();
    if (elapsedMs < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      return jsonError(
        429,
        'resend_cooldown',
        `A new code can be requested in ${OTP_RESEND_COOLDOWN_SECONDS} seconds.`,
      );
    }
  }

  // Consume prior unexpired, unused rows — exactly one live code per profile.
  const consume = await admin
    .from('phone_verifications')
    .update({ expires_at: new Date(nowMs).toISOString() })
    .eq('user_id', profile.id)
    .is('verified_at', null)
    .gt('expires_at', new Date(nowMs).toISOString());
  if (consume.error) {
    console.error('Phone OTP request failed to consume prior rows:', consume.error.message);
    return jsonError(500, 'otp_request_failed', 'Phone verification could not be requested.');
  }

  const code = generateOtp();
  const insert = await admin.from('phone_verifications').insert({
    user_id: profile.id,
    phone,
    otp_hash: hashOtp(profile.id, phone, code, otpHashSecret),
    expires_at: new Date(nowMs + OTP_TTL_MINUTES * 60_000).toISOString(),
  });
  if (insert.error) {
    console.error('Phone OTP request failed to store the verification:', insert.error.message);
    return jsonError(500, 'otp_request_failed', 'Phone verification could not be requested.');
  }

  // Best-effort delivery — fail-open by construction. A provider that
  // throws (timeout, DNS, reset) degrades to delivered: false, never an
  // error wall; the code stays safe to have stored because it is never in
  // any response, and the none provider logs it server-side.
  let delivered = false;
  try {
    const provider = getSmsProvider();
    const result = await provider.sendSms(phone, buildOtpMessage(code));
    delivered = result.ok;
  } catch (error) {
    console.error('Phone OTP SMS provider crashed — delivery degraded to skip path:', error);
  }

  return genericSuccess(delivered);
}
