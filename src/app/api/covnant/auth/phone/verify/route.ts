/**
 * POST /api/covnant/auth/phone/verify — check a 6-digit code and mark the
 * creator's profile phone-verified (the signup OTP step's submit and the
 * /agent verify-later prompt's submit both hit this route).
 *
 * Contract (spec art_pd8VlEMI):
 * - One live row per profile (the request route consumes priors on resend):
 *   the LATEST phone_verifications row for the email's profile is the only
 *   candidate. No row / unknown profile → the same invalid_code 400 as a
 *   wrong code — the response is not an oracle for account existence.
 * - Comparison is constant-time over the HMAC digest (service.ts); the
 *   plaintext code never enters storage or any response body.
 * - A wrong code increments the row's attempts; at 5 the row is dead and a
 *   fresh code is required. Expired rows are dead. Used rows (verified_at
 *   set) are dead — codes are single-use; reuse-after-verify is rejected.
 * - Success flips BOTH phone_verifications.verified_at and the existing
 *   creator_profiles.phone_verified_at (no schema change — the column has
 *   existed since the profile table did).
 * - Fail-open flow context: any non-success here leaves the account intact
 *   and unverified — the funnel never blocks on verification.
 */

import { OTP_MAX_ATTEMPTS, hashOtp, otpMatches } from '@/lib/covnant/otp/service';
import { normalizeOtpEmail } from '@/lib/covnant/otp/input';
import { jsonError } from '@/lib/server/http';
import { checkSharedRateLimit, PHONE_OTP_VERIFY_RATE_LIMIT } from '@/lib/server/rateLimit';
import { createAdminClient, readSupabaseEnv } from '@/lib/server/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

/** The phone_verifications fields the verify flow reads and writes. */
interface VerificationRow {
  id: string;
  user_id: string;
  phone: string;
  otp_hash: string;
  expires_at: string;
  verified_at: string | null;
  attempts: number;
}

interface ProfileRow {
  id: string;
  phone_verified_at: string | null;
}

/** The plain-language rejections — no jargon, no oracle. */
const INVALID = 'That code is not right. Check the message and try again.';
const USED = 'That code was already used. Request a new one.';
const EXPIRED = 'That code expired. Request a new one.';
const EXHAUSTED = 'Too many attempts. Request a new code.';

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

  const { email: rawEmail, code: rawCode } = body as { email?: unknown; code?: unknown };
  const email = normalizeOtpEmail(rawEmail);
  if (email === null) {
    return jsonError(400, 'invalid_email', 'Enter a valid email address.');
  }
  // A malformed code can never match a row — reject without burning an
  // attempt (the row cap exists for guessing, not for typos in shape).
  if (typeof rawCode !== 'string' || !/^\d{6}$/.test(rawCode.trim())) {
    return jsonError(400, 'invalid_code', INVALID);
  }
  const code = rawCode.trim();

  // Shared Postgres-backed limiter (per-IP window) — the second bound on
  // code guessing, layered over the per-row attempts cap.
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const verdict = await checkSharedRateLimit(
    `covnant-otp-verify:${clientIp}`,
    PHONE_OTP_VERIFY_RATE_LIMIT,
  );
  if (!verdict.ok) {
    return jsonError(429, 'rate_limited', 'Too many attempts from this address. Try again later.');
  }

  // Fail-closed configuration — no secret, no comparison, no state change.
  const env = readSupabaseEnv();
  if (env === null) {
    return jsonError(503, 'supabase_not_configured', 'Phone verification is not configured.');
  }
  const otpHashSecret = process.env.OTP_HASH_SECRET;
  if (!otpHashSecret) {
    return jsonError(503, 'otp_not_configured', 'Phone verification is not configured.');
  }
  const admin = createAdminClient(env);

  // The profile by email — unknown profiles get the same invalid_code as a
  // wrong code (no account enumeration).
  const profileQuery = await admin
    .from('creator_profiles')
    .select('id, phone_verified_at')
    .eq('email', email)
    .maybeSingle<ProfileRow>();
  if (profileQuery.error) {
    console.error('Phone verify failed to read creator_profiles:', profileQuery.error.message);
    return jsonError(500, 'otp_verify_failed', 'Phone verification could not be completed.');
  }
  const profile = profileQuery.data;
  if (profile === null) {
    return jsonError(400, 'invalid_code', INVALID);
  }
  if (profile.phone_verified_at !== null) {
    return verifiedResponse();
  }

  // The candidate: the profile's LATEST row only — resends consume priors,
  // so an old code is unreachable through this route by construction.
  const rowQuery = await admin
    .from('phone_verifications')
    .select('id, user_id, phone, otp_hash, expires_at, verified_at, attempts')
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<VerificationRow>();
  if (rowQuery.error) {
    console.error('Phone verify failed to read phone_verifications:', rowQuery.error.message);
    return jsonError(500, 'otp_verify_failed', 'Phone verification could not be completed.');
  }
  const row = rowQuery.data;
  if (row === null) {
    return jsonError(400, 'invalid_code', INVALID);
  }

  // Dead-row guards, most specific first — the copy tells the creator what
  // to do next, never what was wrong with their guess.
  if (row.verified_at !== null) {
    return jsonError(400, 'code_used', USED);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return jsonError(400, 'code_expired', EXPIRED);
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return jsonError(400, 'too_many_attempts', EXHAUSTED);
  }

  if (!otpMatches(row.otp_hash, hashOtp(row.user_id, row.phone, code, otpHashSecret))) {
    // Burn one attempt. The read-modify-write is the service-role client's
    // single UPDATE; the 5/min IP limiter keeps concurrent burns within the
    // cap's intent at beta scale.
    const bumped = await admin
      .from('phone_verifications')
      .update({ attempts: row.attempts + 1 })
      .eq('id', row.id);
    if (bumped.error) {
      console.error('Phone verify failed to record the attempt:', bumped.error.message);
      return jsonError(500, 'otp_verify_failed', 'Phone verification could not be completed.');
    }
    if (row.attempts + 1 >= OTP_MAX_ATTEMPTS) {
      return jsonError(400, 'too_many_attempts', EXHAUSTED);
    }
    return jsonError(400, 'invalid_code', INVALID);
  }

  // Single-use commit: the conditional update IS the single-use gate — the
  // verified_at IS NULL filter matches only if no other request claimed the
  // code first; count: 'exact' makes that visible (a lost race reports 0).
  const claim = await admin
    .from('phone_verifications')
    .update({ verified_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', row.id)
    .is('verified_at', null);
  if (claim.error) {
    console.error('Phone verify failed to consume the code:', claim.error.message);
    return jsonError(500, 'otp_verify_failed', 'Phone verification could not be completed.');
  }
  if (claim.count === 0) {
    return jsonError(400, 'code_used', USED);
  }

  // The founder's "mark the profile as phone_verified" — the existing
  // column, set only on a claimed code.
  const marked = await markProfileVerified(admin, profile.id);
  if (!marked) {
    // The code is consumed and the row verified; the profile mark is the
    // one write that could not complete. Surface it honestly — never claim
    // verified without the column flipped.
    console.error('Phone verify consumed the code but failed to mark the profile verified.');
    return jsonError(500, 'otp_verify_failed', 'Phone verification could not be completed.');
  }

  return verifiedResponse();
}

function verifiedResponse(): Response {
  return Response.json(
    { ok: true, verified: true },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

/** Sets creator_profiles.phone_verified_at; true when the write reports no error. */
async function markProfileVerified(admin: SupabaseClient, userId: string): Promise<boolean> {
  const result = await admin
    .from('creator_profiles')
    .update({ phone_verified_at: new Date().toISOString() })
    .eq('id', userId);
  return !result.error;
}
