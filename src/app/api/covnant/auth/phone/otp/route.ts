/**
 * POST /api/covnant/auth/phone/otp — the HTTP adapter over the shared phone
 * OTP lifecycle (`requestPhoneOtp`). The full contract — eligibility, the
 * no-enumeration envelope, the server-enforced cooldown, fail-open delivery
 * through the WhatsApp → Textbee → none chain — lives in
 * src/lib/covnant/otp/lifecycle.ts; this file is transport only: it maps
 * lifecycle outcomes to HTTP responses and never sees a code.
 *
 * The internal MCP tool send_phone_otp maps the SAME outcomes to tool
 * results — one service path, one set of rate limits, two transports.
 */

import { requestPhoneOtp } from '@/lib/covnant/otp/lifecycle';
import { OTP_RESEND_COOLDOWN_SECONDS } from '@/lib/covnant/otp/service';
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
  const { email, phone } = body as { email?: unknown; phone?: unknown };

  // Shared Postgres-backed limiter (per-IP window here; the per-phone half
  // is the cooldown inside the lifecycle) — one of the tightest windows in
  // the app because every allowed call can spend a real SMS.
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  const result = await requestPhoneOtp(clientIp, { email, phone });

  switch (result.outcome) {
    case 'invalid_input':
      return result.reason === 'invalid_email'
        ? jsonError(400, 'invalid_email', 'Enter a valid email address.')
        : jsonError(
            400,
            'invalid_phone',
            "That phone number doesn't look right — enter a real number, any format works.",
          );
    case 'not_configured':
      return jsonError(503, result.reason, 'Phone verification is not configured.');
    case 'rate_limited':
      return result.kind === 'ip_window'
        ? jsonError(429, 'rate_limited', 'Too many code requests from this address. Try again later.')
        : jsonError(
            429,
            'resend_cooldown',
            `A new code can be requested in ${OTP_RESEND_COOLDOWN_SECONDS} seconds.`,
          );
    case 'store_error':
      return jsonError(500, 'otp_request_failed', 'Phone verification could not be requested.');
    case 'sent':
      // The generic no-enumeration success body — identical shape either way.
      return Response.json(
        { ok: true, delivered: result.delivered, deliveredVia: result.deliveredVia },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
  }
}
