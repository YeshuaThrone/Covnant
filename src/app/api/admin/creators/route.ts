/**
 * GET /api/admin/creators — gated creator_profiles listing for the admin
 * console (every 0003 identity + 0004 compliance column).
 *
 * GATED: the signed admin session cookie is verified before any data is
 * read — an unset ADMIN_DASHBOARD_PASSWORD answers 503
 * admin_not_configured, an absent/expired/invalid cookie answers 401, and
 * neither failure response carries data. Reads the service-role client
 * server-side; the credential is never exposed.
 */

import { checkAdminGate } from '@/lib/admin/gate';
import { listCreators } from '@/lib/admin/creators';
import { jsonError } from '@/lib/server/http';
import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  const db = supabaseFromEnv();
  if (!db) {
    return jsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }

  const result = await listCreators(db);
  if (!result.ok) return jsonError(result.status, result.code, result.message);

  return Response.json(
    { ok: true, creators: result.value },
    { headers: { 'cache-control': 'no-store' } },
  );
}
