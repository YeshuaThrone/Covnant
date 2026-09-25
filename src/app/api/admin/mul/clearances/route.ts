/**
 * POST /api/admin/mul/clearances — move one asset's MUL clearance along the
 * machine; GET /api/admin/mul/clearances?asset_cbt_code=… — read an asset's
 * current clearance and its append-only transition history.
 *
 * The MUL admin surface, API-only in v1 (build spec open item #4
 * recommendation): the admin console gains clearance screens in a later
 * phase, so this route is the entire operator surface. All domain rules —
 * the state machine, territory (ISO 3166-1), term parsing, licensee
 * tracking — live in the SDK module (covnant-sdk/src/mul/clearance.ts),
 * which persists through the Store seam's mul_clearances methods (PR 3).
 * The route is the wire: admin gate, shape checks, and typed-refusal
 * mapping — it invents no rules of its own.
 *
 * GATED: the signed admin session cookie is verified before any data is
 * touched — an unset ADMIN_DASHBOARD_PASSWORD answers 503
 * admin_not_configured, an absent/expired/invalid cookie answers 401, and
 * neither failure response carries data. Fail-closed elsewhere: an
 * unconfigured store answers 503 store_not_configured before any query
 * runs. Rate limited per address AFTER validation so a malformed body
 * never burns the bucket.
 *
 * Wire mapping of the SDK's typed refusals: an illegal machine edge reads
 * 409 invalid_transition (the asset's current state is the conflict — a
 * replayed or out-of-order transition is a caller bug, not a no-op), an
 * invalid field reads 422 with the SDK's stable code and field name.
 *
 * LOGGED like every console mutation: each effective transition writes
 * exactly ONE admin_action_log row with the field-level before/after
 * (the transitionClearanceWithAudit discipline), and a failed audit insert
 * compensates — the prior clearance row is restored best-effort and the
 * route answers 502 admin_action_log_failed. With no Supabase audit
 * destination the mutation is refused outright (503): a clearance change
 * never stands unlogged.
 */

import { checkAdminGate } from '@/lib/admin/gate';
import { transitionClearanceWithAudit } from '@/lib/admin/mulClearances';
import { jsonError } from '@/lib/server/http';
import { ADMIN_API_RATE_LIMIT, checkRateLimit } from '@/lib/server/rateLimit';
import { getStore } from '@/lib/server/store';
import { supabaseFromEnv } from '@/lib/supabase';
import {
  CLEARANCE_STATES,
  ClearanceTransitionError,
  MulClearanceValidationError,
  getClearance,
  transitionFromRecord,
  type ClearanceState,
} from '../../../../../../covnant-sdk/src/mul/clearance';

export const dynamic = 'force-dynamic';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clientAddress(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

function rateLimited(retryAfterSeconds: number): Response {
  return Response.json(
    {
      ok: false,
      error: `Too many MUL clearance requests. Try again in ${retryAfterSeconds}s.`,
      reason: 'rate_limited',
    },
    {
      status: 429,
      headers: { 'cache-control': 'no-store', 'retry-after': String(retryAfterSeconds) },
    },
  );
}

function storeOr503(): { store: ReturnType<typeof getStore> } | { response: Response } {
  try {
    return { store: getStore() };
  } catch {
    // Fail closed: the singleton's only throw is the unconfigured-store one.
    return {
      response: jsonError(
        503,
        'store_not_configured',
        'Store is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).',
      ),
    };
  }
}

export async function POST(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }
  const payload = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  const assetCbtCode = payload.assetCbtCode;
  const to = payload.to;
  if (!isNonEmptyString(assetCbtCode)) {
    return jsonError(400, 'missing_asset_cbt_code', 'assetCbtCode is required.');
  }
  if (!isNonEmptyString(to) || !CLEARANCE_STATES.includes(to as ClearanceState)) {
    return jsonError(
      422,
      'invalid_state',
      `to must be one of: ${CLEARANCE_STATES.join(', ')}.`,
    );
  }

  const verdict = checkRateLimit(`covnant-admin-mul:${clientAddress(request)}`, ADMIN_API_RATE_LIMIT);
  if (!verdict.ok) return rateLimited(verdict.retryAfterSeconds);

  const configured = storeOr503();
  if ('response' in configured) return configured.response;

  // Fail closed BEFORE the mutation: with no audit destination a transition
  // could never be logged, and a clearance change never stands unlogged.
  const auditDb = supabaseFromEnv();
  if (!auditDb) {
    return jsonError(503, 'supabase_not_configured', 'Supabase credentials are not configured.');
  }

  // Field validation belongs to the SDK module — the wire forwards the raw
  // optional fields and maps each typed refusal to its status below. The
  // audited wrapper owns read-before/audit/compensate; SDK typed refusals
  // still throw for the mapping here.
  try {
    const result = await transitionClearanceWithAudit(configured.store, auditDb, {
      assetCbtCode,
      to: to as ClearanceState,
      licensee: payload.licensee as string | null | undefined,
      territory: payload.territory as string | null | undefined,
      termStart: payload.termStart as string | null | undefined,
      termEnd: payload.termEnd as string | null | undefined,
      note: payload.note as string | null | undefined,
    });
    if (!result.ok) return jsonError(result.status, result.code, result.message);
    return Response.json(
      { ok: true, clearance: result.value.clearance, action: result.value.action },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ClearanceTransitionError) {
      return jsonError(
        409,
        'invalid_transition',
        `${error.code} — the clearance machine has no such edge; the asset's current state is the conflict.`,
      );
    }
    if (error instanceof MulClearanceValidationError) {
      return jsonError(422, error.code, `${error.field}: ${error.message}`);
    }
    throw error;
  }
}

export async function GET(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  const url = new URL(request.url);
  const assetCbtCode = url.searchParams.get('asset_cbt_code');
  if (!isNonEmptyString(assetCbtCode)) {
    return jsonError(400, 'missing_asset_cbt_code', 'asset_cbt_code is required.');
  }

  const verdict = checkRateLimit(`covnant-admin-mul:${clientAddress(request)}`, ADMIN_API_RATE_LIMIT);
  if (!verdict.ok) return rateLimited(verdict.retryAfterSeconds);

  const configured = storeOr503();
  if ('response' in configured) return configured.response;

  const clearance = await getClearance(configured.store, assetCbtCode.trim());
  if (clearance === null) {
    return Response.json(
      { ok: true, found: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const transitions = (await configured.store.listClearanceTransitions(assetCbtCode.trim())).map(
    transitionFromRecord,
  );
  return Response.json(
    { ok: true, found: true, clearance, transitions },
    { headers: { 'cache-control': 'no-store' } },
  );
}
