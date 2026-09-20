/**
 * /api/v1/contracts/execute — the Universal Execution Lane door (founder
 * GO, 2026-09-20: the execution lane serves EVERY vertical of
 * entertainment).
 *
 *   GET  ?template=<key>&cbt=<token> — hydration payload for the execution
 *        surface (the same ONE seam the page builds from directly:
 *        resolveExecutionLane → either-library template resolution →
 *        integer pool reconciliation → guard verdicts → telemetry →
 *        CBT/CVT lineage).
 *   POST { templateKey, cbt } — validates through the kernel (guard
 *        verdicts + pool reconciliation to exactly 10,000 BPS), mints the
 *        CBT-stamped execution record, lands it in the master clearing
 *        ledger through the store path, and returns the stamped payload.
 *
 * Fail-closed by construction:
 *   - an unknown template key or CBT is a 404 (unknown_template /
 *     unknown_cbt) — no invented records;
 *   - a blocked guard verdict is a 409 (guard_blocked) carrying the
 *     blocked verdicts — nothing lands in the ledger;
 *   - a bound entity that fails its served-entity validation is a 502
 *     (entity_guard_failed) — unreachable while the store's integrity
 *     gates hold.
 *
 * AUTH: this door serves the same store-engine data the /contracts/new
 * page renders (workspace shell, session-gated) and the /templates page
 * already reads publicly — the POST is that page's own execution action.
 * It is not an /api/admin surface, so the J1 preview carve-out
 * (verifyAdminSession's DON_DEV_SEED passwordless branch) is not involved.
 * POST is rate limited like the other engine-write doors.
 */

import type { NextRequest } from 'next/server';

import { jsonError } from '@/lib/server/http';
import { checkRateLimit, DON_API_RATE_LIMIT } from '@/lib/server/rateLimit';
import { clientIdentity } from '@/modules/don/http';
import { EXECUTION_LANE_ROUTE_MANIFEST, mintExecutionLane, resolveExecutionLane } from '@/lib/master/executionLane';

export const dynamic = 'force-dynamic';

/** The binding pair a lane request carries — template key + CBT token. */
interface LaneBinding {
  readonly templateKey: string;
  readonly cbt: string;
}

function parseBindingFromQuery(url: URL): LaneBinding | null {
  const templateKey = url.searchParams.get('template');
  const cbt = url.searchParams.get('cbt');
  return templateKey && cbt ? { templateKey, cbt } : null;
}

function parseBindingFromBody(body: unknown): LaneBinding | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as { templateKey?: unknown; cbt?: unknown };
  return typeof candidate.templateKey === 'string' && typeof candidate.cbt === 'string'
    ? { templateKey: candidate.templateKey, cbt: candidate.cbt }
    : null;
}

/** Map a failed lane resolution onto its fail-closed wire response. */
function resolutionError(reason: 'unknown_template' | 'unknown_cbt' | 'entity_guard_failed', binding: LaneBinding): Response {
  switch (reason) {
    case 'unknown_template':
      return jsonError(404, 'unknown_template', `Unknown template key: ${binding.templateKey}`);
    case 'unknown_cbt':
      return jsonError(404, 'unknown_cbt', `Unknown CBT token: ${binding.cbt}`);
    case 'entity_guard_failed':
      return jsonError(502, 'entity_guard_failed', 'The bound entity failed its fail-closed guard');
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const binding = parseBindingFromQuery(new URL(request.url));
  if (!binding) {
    return jsonError(400, 'missing_binding', 'Both template and cbt query parameters are required');
  }
  const resolution = resolveExecutionLane(binding);
  if (!resolution.ok) {
    return resolutionError(resolution.reason, binding);
  }
  const body = {
    ok: true,
    demo: resolution.demo,
    lane: resolution.lane,
    manifest: EXECUTION_LANE_ROUTE_MANIFEST,
  };
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: NextRequest): Promise<Response> {
  const identity = clientIdentity(request);
  const limit = checkRateLimit(identity, DON_API_RATE_LIMIT);
  if (!limit.ok) {
    return jsonError(429, 'rate_limited', `Rate limit exceeded. Retry after ${limit.retryAfterSeconds}s.`);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON');
  }
  const binding = parseBindingFromBody(body);
  if (!binding) {
    return jsonError(400, 'invalid_binding', 'templateKey and cbt are required string fields');
  }

  const minted = mintExecutionLane(binding);
  if (!minted.ok) {
    if (minted.reason === 'guard_blocked') {
      return Response.json(
        {
          ok: false,
          error: 'The binding is blocked by a fail-closed guard',
          reason: 'guard_blocked',
          guardReport: minted.guardReport,
        },
        { status: 409, headers: { 'cache-control': 'no-store' } },
      );
    }
    return resolutionError(minted.reason, binding);
  }

  const responseBody = {
    ok: true,
    ledgerId: minted.ledgerRecord.ledgerId,
    ledgerRecord: minted.ledgerRecord,
    lane: minted.lane,
  };
  return Response.json(responseBody, { status: 201, headers: { 'cache-control': 'no-store' } });
}
