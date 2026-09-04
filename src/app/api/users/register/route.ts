/**
 * POST /api/users/register — creator telemetry registration (gateway wiring).
 *
 * Contract (directive A):
 *   - The caller's Supabase JWT is verified server-side via auth.getUser —
 *     unauthenticated calls get 401 with nothing written.
 *   - The camelCase payload maps to the creator_telemetry columns
 *     (0003_gateway_telemetry.sql). Rows insert through the server-only
 *     service-role credential after verification; the table's RLS insert
 *     policy (auth.uid() = auth_user_id) scopes any direct client path.
 *   - Memory mode (no Supabase credentials): the repo's established fallback.
 *     The Authorization header is still required — unauthenticated callers
 *     never pass — and the bearer acts as an opaque local session id, since
 *     no Supabase auth provider exists to verify against.
 */

import { resolveDataSourceMode } from '@/lib/data-source';
import { bearerToken, unauthorizedResponse } from '@/lib/gateway/http';
import { E164_PHONE_PATTERN } from '@/lib/gateway/phone';
import { insertCreatorTelemetry } from '@/lib/gateway/telemetry';
import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RegisterUserPayload {
  legalName: string;
  artistName: string;
  regularEmail: string;
  businessEmail?: string;
  phone: string;
  phoneVerified: true;
}

function isRegisterUserPayload(value: unknown): value is RegisterUserPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const isFilled = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const businessEmailOk =
    p.businessEmail === undefined ||
    p.businessEmail === '' ||
    (typeof p.businessEmail === 'string' && EMAIL_PATTERN.test(p.businessEmail));
  return (
    isFilled(p.legalName) &&
    isFilled(p.artistName) &&
    typeof p.regularEmail === 'string' &&
    EMAIL_PATTERN.test(p.regularEmail) &&
    businessEmailOk &&
    typeof p.phone === 'string' &&
    E164_PHONE_PATTERN.test(p.phone) &&
    p.phoneVerified === true
  );
}

export async function POST(request: Request): Promise<Response> {
  const bearer = bearerToken(request);
  if (!bearer) return unauthorizedResponse();

  let authUserId: string;
  if (resolveDataSourceMode() === 'supabase') {
    const db = supabaseFromEnv();
    if (!db) return unauthorizedResponse();
    const { data, error } = await db.auth.getUser(bearer);
    if (error || !data.user) return unauthorizedResponse();
    authUserId = data.user.id;
  } else {
    authUserId = bearer;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: 'Request body must be valid JSON.' },
      { status: 400 }
    );
  }

  if (!isRegisterUserPayload(body)) {
    return Response.json(
      {
        ok: false,
        error:
          'Invalid registration payload: legalName, artistName, regularEmail, phone (+1 E.164) and phoneVerified=true are required.',
      },
      { status: 400 }
    );
  }

  let record;
  try {
    record = await insertCreatorTelemetry({
      authUserId,
      legalName: body.legalName.trim(),
      artistName: body.artistName.trim(),
      regularEmail: body.regularEmail.trim(),
      businessEmail: body.businessEmail ? body.businessEmail.trim() : undefined,
      phone: body.phone,
      phoneVerified: true,
      verifiedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Persistence failure surfaces as a uniform 500 — internals never leak.
    console.error('Creator telemetry insert failed:', err);
    return Response.json(
      { ok: false, error: 'Failed to persist creator telemetry' },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }

  return Response.json(
    { ok: true, mode: resolveDataSourceMode(), record },
    { status: 201, headers: { 'cache-control': 'no-store' } }
  );
}
