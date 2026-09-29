/**
 * POST /api/covnant/auth/phone/verify — the HTTP adapter over the shared
 * phone OTP lifecycle (`verifyPhoneOtp`). The full contract — the latest-row
 * candidate, constant-time HMAC compare, single-use conditional claim,
 * attempt cap, and the creator_profiles.phone_verified_at flip — lives in
 * src/lib/covnant/otp/lifecycle.ts; this file is transport only. Fail-open
 * flow context: any non-success leaves the account intact and unverified —
 * the funnel never blocks on verification.
 *
 * The internal MCP tool verify_phone_otp maps the SAME outcomes to tool
 * results — one service path, one set of rate limits, two transports.
 */

import { OTP_REJECTION_COPY, verifyPhoneOtp } from '@/lib/covnant/otp/lifecycle';
import { jsonError } from '@/lib/server/http';

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
  const { email, code } = body as { email?: unknown; code?: unknown };

  // Shared Postgres-backed limiter (per-IP window) — the second bound on
  // code guessing, layered over the per-row attempts cap.
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  const result = await verifyPhoneOtp(clientIp, { email, code });

  switch (result.outcome) {
    case 'invalid_input':
      return result.reason === 'invalid_email'
        ? jsonError(400, 'invalid_email', 'Enter a valid email address.')
        : jsonError(400, 'invalid_code', OTP_REJECTION_COPY.invalid_code);
    case 'not_configured':
      return jsonError(503, result.reason, 'Phone verification is not configured.');
    case 'rate_limited':
      return jsonError(429, 'rate_limited', 'Too many attempts from this address. Try again later.');
    case 'store_error':
      return jsonError(500, 'otp_verify_failed', 'Phone verification could not be completed.');
    case 'rejected':
      return jsonError(400, result.reason, OTP_REJECTION_COPY[result.reason]);
    case 'verified':
      return Response.json(
        { ok: true, verified: true },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
  }
}
