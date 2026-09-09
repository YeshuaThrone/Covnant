/**
 * /api/admin/creators/[id] — gated creator detail + the FIRST compliance
 * mutation (PATCH, v1-editable fields only: kyc_status, tax_form_type,
 * tax_verified).
 *
 * GATED: the signed admin session cookie is verified before anything else —
 * unset env → 503 admin_not_configured, absent/expired/invalid cookie →
 * 401; neither failure carries data.
 *
 * PATCH discipline (the platform's first creator_profiles mutation):
 *   - the body is whitelist-validated server-side BEFORE any write — the
 *     database has no CHECK constraints (the enum domains exist only as
 *     column comments), so an invalid value is rejected here with nothing
 *     half-written;
 *   - every effective mutation writes exactly ONE admin_action_log row with
 *     field-level before/after, and the log record rides back in the
 *     response;
 *   - read-only fields (bank_account_linked, email, identity columns) are
 *     rejected, never silently dropped.
 */

import { checkAdminGate } from '@/lib/admin/gate';
import { getCreator, updateCreatorCompliance, validateCompliancePatch } from '@/lib/admin/creators';
import { jsonError } from '@/lib/server/http';
import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

async function resolveId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return id;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  const db = supabaseFromEnv();
  if (!db) {
    return jsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }

  const result = await getCreator(db, await resolveId(context));
  if (!result.ok) return jsonError(result.status, result.code, result.message);

  return Response.json(
    { ok: true, profile: result.value },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  const db = supabaseFromEnv();
  if (!db) {
    return jsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }

  const validation = validateCompliancePatch(body);
  if (!validation.ok) {
    return jsonError(validation.status, validation.code, validation.message);
  }

  const result = await updateCreatorCompliance(db, await resolveId(context), validation.value);
  if (!result.ok) return jsonError(result.status, result.code, result.message);

  return Response.json(
    { ok: true, profile: result.value.profile, action: result.value.action },
    { headers: { 'cache-control': 'no-store' } },
  );
}
