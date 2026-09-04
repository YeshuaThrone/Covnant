/**
 * GET /api/admin/ledger — CEO/admin creator telemetry read (gateway wiring).
 *
 * Contract (directive B):
 *   - 401 unauthenticated (missing/invalid Supabase session token).
 *   - 403 authenticated non-admins — the response carries no data rows.
 *   - Admin determination is server-side: the caller's verified auth user id
 *     must hold a platform_admin_allowlists row (0003_gateway_telemetry.sql).
 *     creator_telemetry's RLS select policy mirrors the same admin gate for
 *     direct client reads; the service-role credential is used here only
 *     after that explicit server-side admin check, and never leaves the server.
 *   - Memory mode: the same contract against the process-local admin set
 *     (grantMemoryAdmin fixture) and telemetry index.
 */

import { resolveDataSourceMode } from '@/lib/data-source';
import { bearerToken, forbiddenResponse, unauthorizedResponse } from '@/lib/gateway/http';
import { isMemoryAdmin, isPlatformAdmin, listCreatorTelemetry } from '@/lib/gateway/telemetry';
import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const bearer = bearerToken(request);
  if (!bearer) return unauthorizedResponse();

  let isAdmin = false;
  if (resolveDataSourceMode() === 'supabase') {
    const db = supabaseFromEnv();
    if (!db) return unauthorizedResponse();
    const { data, error } = await db.auth.getUser(bearer);
    if (error || !data.user) return unauthorizedResponse();
    isAdmin = await isPlatformAdmin(db, data.user.id);
  } else {
    isAdmin = isMemoryAdmin(bearer);
  }

  if (!isAdmin) return forbiddenResponse();

  const records = await listCreatorTelemetry();
  return Response.json(
    { ok: true, records },
    { headers: { 'cache-control': 'no-store' } }
  );
}
