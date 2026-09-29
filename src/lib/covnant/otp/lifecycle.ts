/**
 * The phone OTP lifecycle — the ONE implementation of "request a code" and
 * "verify a code", shared by the canonical HTTP routes
 * (/api/covnant/auth/phone/*) and the internal MCP onboarding tools
 * (send_phone_otp / verify_phone_otp). The founder directive requires the
 * MCP tools to run the SAME service path and the SAME shared rate limits as
 * the routes — so the routes are thin transport adapters over this module,
 * never a second implementation.
 *
 * Contracts (spec art_pd8VlEMI + amended locked decisions):
 * - Request: the { email, phone } pair must match an EXISTING unverified
 *   creator_profiles row; every other case returns the same generic "sent
 *   with delivered:false" outcome as a real send (no account enumeration).
 *   60-second resend cooldown server-enforced; a new request consumes prior
 *   unexpired rows; delivery is best-effort fail-open through the fallback
 *   chain (WhatsApp → Textbee → none).
 * - Verify: constant-time compare over the HMAC digest; single-use
 *   conditional claim; attempts capped; success flips BOTH the row's
 *   verified_at and the existing creator_profiles.phone_verified_at.
 *   Unknown profiles and wrong codes are indistinguishable.
 * - Codes never appear in any outcome — they exist only inside the SMS body
 *   handed to the provider and (pre-config) the server console.
 *
 * `clientKey` names the rate-limit bucket: HTTP adapters pass their per-IP
 * key; the MCP host passes the shared internal-onboarding key so the tool
 * surface is bounded by the same limiter.
 */

import { normalizeOtpEmail } from '@/lib/covnant/otp/input';
import { normalizeOptionalE164 } from '@/lib/covnant/signupValidation';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  buildOtpMessage,
  generateOtp,
  hashOtp,
  otpMatches,
} from '@/lib/covnant/otp/service';
import { getSmsProvider } from '@/lib/covnant/otp/smsProvider';
import {
  checkSharedRateLimit,
  PHONE_OTP_REQUEST_RATE_LIMIT,
  PHONE_OTP_VERIFY_RATE_LIMIT,
} from '@/lib/server/rateLimit';
import { createAdminClient, readSupabaseEnv } from '@/lib/server/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The creator_profiles fields the OTP flow reads. */
interface ProfileRow {
  id: string;
  phone: string | null;
  phone_verified_at: string | null;
}

/** The phone_verifications fields the flows read. */
interface VerificationRow {
  id: string;
  user_id: string;
  phone: string;
  otp_hash: string;
  expires_at: string;
  verified_at: string | null;
  attempts: number;
}

interface LatestVerificationRow {
  created_at: string;
}

/** The plain-language rejections — no jargon, no oracle. Shared by every surface. */
export const OTP_REJECTION_COPY = {
  invalid_code: 'That code is not right. Check the message and try again.',
  code_used: 'That code was already used. Request a new one.',
  code_expired: 'That code expired. Request a new one.',
  too_many_attempts: 'Too many attempts. Request a new code.',
} as const;

export type PhoneOtpRejectionReason = keyof typeof OTP_REJECTION_COPY;

export type PhoneOtpRequestOutcome =
  | { outcome: 'invalid_input'; reason: 'invalid_email' | 'invalid_phone' }
  | { outcome: 'not_configured'; reason: 'supabase_not_configured' | 'otp_not_configured' }
  | { outcome: 'rate_limited'; kind: 'ip_window' | 'resend_cooldown' }
  | { outcome: 'store_error' }
  | { outcome: 'sent'; delivered: boolean; deliveredVia: string | null };

export type PhoneOtpVerifyOutcome =
  | { outcome: 'invalid_input'; reason: 'invalid_email' | 'invalid_code' }
  | { outcome: 'not_configured'; reason: 'supabase_not_configured' | 'otp_not_configured' }
  | { outcome: 'rate_limited' }
  | { outcome: 'store_error' }
  | { outcome: 'verified' }
  | { outcome: 'rejected'; reason: PhoneOtpRejectionReason };

export async function requestPhoneOtp(
  clientKey: string,
  input: { email: unknown; phone: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PhoneOtpRequestOutcome> {
  const email = normalizeOtpEmail(input.email);
  if (email === null) {
    return { outcome: 'invalid_input', reason: 'invalid_email' };
  }
  const phoneResult = normalizeOptionalE164(input.phone);
  if (!phoneResult.ok || phoneResult.phone === null) {
    return { outcome: 'invalid_input', reason: 'invalid_phone' };
  }
  const phone = phoneResult.phone;

  // Shared Postgres-backed limiter (per-IP window) — after validation, so a
  // malformed body never burns the bucket (the signup route's order).
  const verdict = await checkSharedRateLimit(
    `covnant-otp-request:${clientKey}`,
    PHONE_OTP_REQUEST_RATE_LIMIT,
  );
  if (!verdict.ok) {
    return { outcome: 'rate_limited', kind: 'ip_window' };
  }

  // Fail-closed configuration — a missing secret must never yield a code.
  const supabaseEnv = readSupabaseEnv();
  if (supabaseEnv === null) {
    return { outcome: 'not_configured', reason: 'supabase_not_configured' };
  }
  const otpHashSecret = env.OTP_HASH_SECRET;
  if (!otpHashSecret) {
    return { outcome: 'not_configured', reason: 'otp_not_configured' };
  }
  const admin = createAdminClient(supabaseEnv);

  // Eligibility: the profile must exist, carry the SAME canonical phone, and
  // still be unverified. Every ineligible case falls through to the same
  // generic sent/delivered:false outcome as a real send — not an oracle.
  const profileQuery = await admin
    .from('creator_profiles')
    .select('id, phone, phone_verified_at')
    .eq('email', email)
    .maybeSingle<ProfileRow>();
  if (profileQuery.error) {
    console.error('Phone OTP request failed to read creator_profiles:', profileQuery.error.message);
    return { outcome: 'store_error' };
  }
  const profile = profileQuery.data;
  if (profile === null || profile.phone !== phone || profile.phone_verified_at !== null) {
    return { outcome: 'sent', delivered: false, deliveredVia: null };
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
    return { outcome: 'store_error' };
  }
  const nowMs = Date.now();
  const latest = latestQuery.data;
  if (latest !== null) {
    const elapsedMs = nowMs - new Date(latest.created_at).getTime();
    if (elapsedMs < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
      return { outcome: 'rate_limited', kind: 'resend_cooldown' };
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
    return { outcome: 'store_error' };
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
    return { outcome: 'store_error' };
  }

  // Best-effort delivery — fail-open by construction, at every hop of the
  // fallback chain (WhatsApp → Textbee → none). A provider that throws
  // (timeout, DNS, reset) degrades to delivered: false, never an error
  // wall; the code stays safe to have stored because it is never in any
  // outcome, and the none provider logs it server-side.
  let delivered = false;
  let deliveredVia: string | null = null;
  try {
    const provider = getSmsProvider(env);
    const result = await provider.sendSms(phone, { body: buildOtpMessage(code), code });
    delivered = result.ok;
    deliveredVia = result.ok ? result.via ?? null : null;
  } catch (error) {
    console.error('Phone OTP SMS provider crashed — delivery degraded to skip path:', error);
  }

  return { outcome: 'sent', delivered, deliveredVia };
}

export async function verifyPhoneOtp(
  clientKey: string,
  input: { email: unknown; code: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PhoneOtpVerifyOutcome> {
  const email = normalizeOtpEmail(input.email);
  if (email === null) {
    return { outcome: 'invalid_input', reason: 'invalid_email' };
  }
  // A malformed code can never match a row — reject without burning an
  // attempt (the row cap exists for guessing, not for typos in shape).
  const rawCode = input.code;
  if (typeof rawCode !== 'string' || !/^\d{6}$/.test(rawCode.trim())) {
    return { outcome: 'invalid_input', reason: 'invalid_code' };
  }
  const code = rawCode.trim();

  // Shared Postgres-backed limiter (per-IP window) — the second bound on
  // code guessing, layered over the per-row attempts cap.
  const verdict = await checkSharedRateLimit(
    `covnant-otp-verify:${clientKey}`,
    PHONE_OTP_VERIFY_RATE_LIMIT,
  );
  if (!verdict.ok) {
    return { outcome: 'rate_limited' };
  }

  // Fail-closed configuration — no secret, no comparison, no state change.
  const supabaseEnv = readSupabaseEnv();
  if (supabaseEnv === null) {
    return { outcome: 'not_configured', reason: 'supabase_not_configured' };
  }
  const otpHashSecret = env.OTP_HASH_SECRET;
  if (!otpHashSecret) {
    return { outcome: 'not_configured', reason: 'otp_not_configured' };
  }
  const admin = createAdminClient(supabaseEnv);

  // The profile by email — unknown profiles get the same invalid_code as a
  // wrong code (no account enumeration).
  const profileQuery = await admin
    .from('creator_profiles')
    .select('id, phone_verified_at')
    .eq('email', email)
    .maybeSingle<ProfileRow>();
  if (profileQuery.error) {
    console.error('Phone verify failed to read creator_profiles:', profileQuery.error.message);
    return { outcome: 'store_error' };
  }
  const profile = profileQuery.data;
  if (profile === null) {
    return { outcome: 'rejected', reason: 'invalid_code' };
  }
  if (profile.phone_verified_at !== null) {
    return { outcome: 'verified' };
  }

  // The candidate: the profile's LATEST row only — resends consume priors,
  // so an old code is unreachable through this path by construction.
  const rowQuery = await admin
    .from('phone_verifications')
    .select('id, user_id, phone, otp_hash, expires_at, verified_at, attempts')
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<VerificationRow>();
  if (rowQuery.error) {
    console.error('Phone verify failed to read phone_verifications:', rowQuery.error.message);
    return { outcome: 'store_error' };
  }
  const row = rowQuery.data;
  if (row === null) {
    return { outcome: 'rejected', reason: 'invalid_code' };
  }

  // Dead-row guards, most specific first — the copy tells the creator what
  // to do next, never what was wrong with their guess.
  if (row.verified_at !== null) {
    return { outcome: 'rejected', reason: 'code_used' };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { outcome: 'rejected', reason: 'code_expired' };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return { outcome: 'rejected', reason: 'too_many_attempts' };
  }

  if (!otpMatches(row.otp_hash, hashOtp(row.user_id, row.phone, code, otpHashSecret))) {
    // Burn one attempt. The read-modify-write is the service-role client's
    // single UPDATE; the tight IP limiter keeps concurrent burns within the
    // cap's intent at beta scale.
    const bumped = await admin
      .from('phone_verifications')
      .update({ attempts: row.attempts + 1 })
      .eq('id', row.id);
    if (bumped.error) {
      console.error('Phone verify failed to record the attempt:', bumped.error.message);
      return { outcome: 'store_error' };
    }
    if (row.attempts + 1 >= OTP_MAX_ATTEMPTS) {
      return { outcome: 'rejected', reason: 'too_many_attempts' };
    }
    return { outcome: 'rejected', reason: 'invalid_code' };
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
    return { outcome: 'store_error' };
  }
  if (claim.count === 0) {
    return { outcome: 'rejected', reason: 'code_used' };
  }

  // The founder's "mark the profile as phone_verified" — the existing
  // column, set only on a claimed code.
  const marked = await markProfileVerified(admin, profile.id);
  if (!marked) {
    // The code is consumed and the row verified; the profile mark is the
    // one write that could not complete. Surface it honestly — never claim
    // verified without the column flipped.
    console.error('Phone verify consumed the code but failed to mark the profile verified.');
    return { outcome: 'store_error' };
  }

  return { outcome: 'verified' };
}

/** Sets creator_profiles.phone_verified_at; true when the write reports no error. */
async function markProfileVerified(admin: SupabaseClient, userId: string): Promise<boolean> {
  const result = await admin
    .from('creator_profiles')
    .update({ phone_verified_at: new Date().toISOString() })
    .eq('id', userId);
  return !result.error;
}
