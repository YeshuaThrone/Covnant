/**
 * POST /api/admin/login — exchange the ADMIN_DASHBOARD_PASSWORD shared
 * secret for the signed admin session cookie.
 *
 * Fail-closed: unset env → 503 admin_not_configured (no cookie, no hint
 * the console exists); wrong password → 401 admin_invalid_password
 * (generic — there are no users to enumerate). Success mints an httpOnly,
 * SameSite=Lax signed cookie (Secure in production) that every /api/admin
 * route and the gated server action verify. The password itself is never
 * stored, logged, or echoed back; the token's HMAC is keyed by the secret
 * so rotating it invalidates every outstanding session.
 *
 * Rate limited per address (the signup route's limiter) AFTER body
 * validation so a malformed body never burns the bucket — bad passwords
 * do.
 */

import { readAdminPassword, adminPasswordMatches, adminSessionCookie, mintAdminSessionToken } from '@/lib/admin/gate';
import { jsonError } from '@/lib/server/http';
import { checkRateLimit, ADMIN_LOGIN_RATE_LIMIT } from '@/lib/server/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }
  const password = typeof body === 'object' && body !== null ? (body as { password?: unknown }).password : undefined;
  if (typeof password !== 'string' || password.length === 0) {
    return jsonError(400, 'missing_password', 'password is required.');
  }

  // Fail closed when unset — the console does not exist without its secret.
  if (!readAdminPassword()) {
    return jsonError(503, 'admin_not_configured', 'Admin dashboard is not configured.');
  }

  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const verdict = checkRateLimit(`covnant-admin-login:${clientIp}`, ADMIN_LOGIN_RATE_LIMIT);
  if (!verdict.ok) {
    return jsonError(429, 'rate_limited', 'Too many sign-in attempts. Try again later.');
  }

  if (!adminPasswordMatches(password)) {
    return jsonError(401, 'admin_invalid_password', 'Incorrect password.');
  }

  const token = mintAdminSessionToken();
  if (!token) {
    // Unreachable behind the readAdminPassword guard — kept as a paranoid
    // fail-closed backstop rather than an assumption.
    return jsonError(503, 'admin_not_configured', 'Admin dashboard is not configured.');
  }

  return Response.json(
    { ok: true },
    { headers: { 'cache-control': 'no-store', 'set-cookie': adminSessionCookie(token) } },
  );
}
