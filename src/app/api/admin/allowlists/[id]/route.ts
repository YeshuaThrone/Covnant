/**
 * POST /api/admin/allowlists/[id] — flip a platform_allowlists row
 * ACTIVE ↔ REVOKED (the console's only allowlist mutation; creation is
 * deferred). Logged like every other console mutation: exactly one
 * admin_action_log row with the field-level status before/after, riding
 * back in the response.
 *
 * GATED: the signed admin session cookie is verified before anything else —
 * unset env → 503 admin_not_configured, absent/expired/invalid cookie →
 * 401; neither failure carries data.
 */

import { checkAdminGate } from '@/lib/admin/gate';
import { flipAllowlistStatus } from '@/lib/admin/allowlists';
import { jsonError } from '@/lib/server/http';
import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  const db = supabaseFromEnv();
  if (!db) {
    return jsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }

  const { id } = await context.params;
  const result = await flipAllowlistStatus(db, id);
  if (!result.ok) return jsonError(result.status, result.code, result.message);

  return Response.json(
    { ok: true, allowlist: result.value.allowlist, action: result.value.action },
    { headers: { 'cache-control': 'no-store' } },
  );
}
