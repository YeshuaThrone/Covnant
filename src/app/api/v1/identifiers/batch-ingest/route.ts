/**
 * POST /api/v1/identifiers/batch-ingest — Universal Registry Identity Batch
 * Ingestion (founder v13 contract, canon v22/v24/v27 extensions).
 *
 * ENGINE MIDDLEWARE CHAIN (canon v24 order):
 *   1. authenticateJWT — Bearer JWT against JWT_SECRET (fail-closed in
 *      production when unset);
 *   2. requireRole — the ingestion role budget (VIEWER is read-only);
 *   3. Redis sliding-window rate limit (canon v22) — fail-open;
 *   4. Strict structural validation — empty batches are 400 (canon v22
 *      refinement 3: {tenantId, records:[]} is invalid structure);
 *   5. Per-record syntax validation against the live registry (v11/v15/v25)
 *      — any failure rejects the WHOLE batch (422, no partial ingestion);
 *   6. Transactional upserts (Phase 2, shared with the telemetry worker) —
 *      uniqueness binds (primary_code_type, primary_code_value) as a pair
 *      (canon v23 Ruling 2, migration 0012); post-commit the batch emits
 *      its event via the royalty_recon_jobs enqueue seam (v13 diagram, gap
 *      correction) and invalidates the resolution cache (v16 correction).
 *   7. Observability — pino structured log + per-outcome counter (v27).
 *
 * The core handler minus the auth and rate-limit layers is exported as
 * `ingestBatch` — the v22 integration suite binds it (canon v22 flag 4:
 * "auth + rate-limit layers out of suite scope") while still exercising
 * the production Phase-2 code path.
 */

import { NextResponse } from 'next/server';
import { Pool } from 'pg';

import {
  validateIdentifier,
  type IdentityIngestionPayload,
} from '@/lib/identifiers/globalIdentifiers';
import { detectIdentifierHolds } from '@/lib/identifiers/identifierHolds';
import { applyIngestionBatch } from '@/lib/identifiers/ingestRecords';
import { ingestionCounter, logger } from '@/lib/observability/ingestionMetrics';
import {
  authenticateJWT,
  requireRole,
  ENGINE_INGEST_ROLES,
} from '@/lib/server/identifierAuth';
import {
  IDENTIFIER_INGEST_RATE_LIMIT,
  RATE_LIMIT_EXCEEDED_BODY,
  redisSlidingWindowRateLimiter,
} from '@/lib/server/redisRateLimit';

export const dynamic = 'force-dynamic';

export interface IngestionBatchRequest {
  tenantId: string;
  records: IdentityIngestionPayload[];
}

// Lazy pool (convention of src/lib/db.ts): the connection string is read at
// first use, not import time — CI imports the module without DATABASE_URL,
// and the integration suite binds the handler to the scratch database via
// beforeAll before any request runs.
let dbPool: Pool | null = null;

function getDbPool(): Pool {
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
    });
  }
  return dbPool;
}

/** Test-only: drop the cached pool so a later use reconnects. */
export function resetIngestionDbPool(): void {
  dbPool = null;
}

function rateHeaders(
  limit: number,
  remaining: number,
): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
  };
}

/**
 * The core ingestion handler — strict structural validation, the registry
 * syntax gate, and the Phase-2 transactional upsert with its post-commit
 * seam. No auth, no rate limiting (v22 canon flag 4): the composed POST
 * below adds those layers in the canon v24 order.
 */
export async function ingestBatch(request: Request): Promise<NextResponse> {
  // ── 1 · Strict structural validation (canon v22 refinement 3) ─────────
  let body: IngestionBatchRequest;
  try {
    body = (await request.json()) as IngestionBatchRequest;
  } catch {
    body = { tenantId: '', records: [] };
  }
  const { tenantId, records } = body;
  if (!tenantId || !Array.isArray(records) || records.length === 0) {
    ingestionCounter
      .labels({ vertical: 'unknown', status: 'VALIDATION_ERROR' })
      .inc(1);
    return NextResponse.json(
      { error: 'Invalid payload structure or empty records list.' },
      { status: 400 },
    );
  }

  // ── 2 · Per-record syntax validation (registry v11/v15/v25) ───────────
  const validationErrors: Array<{ index: number; error: string }> = [];
  records.forEach((record: IdentityIngestionPayload, index: number) => {
    try {
      if (!validateIdentifier(record.primaryCodeType, record.primaryCodeValue)) {
        validationErrors.push({
          index,
          error: `Value "${record.primaryCodeValue}" failed format validation for type ${record.primaryCodeType}.`,
        });
      }
      (record.crossReferences ?? []).forEach((xref) => {
        if (!validateIdentifier(xref.linkedCodeType, xref.linkedCodeValue)) {
          validationErrors.push({
            index,
            error: `Cross-reference value "${xref.linkedCodeValue}" failed format validation for type ${xref.linkedCodeType}.`,
          });
        }
      });
    } catch (err) {
      validationErrors.push({
        index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  if (validationErrors.length > 0) {
    ingestionCounter
      .labels({ vertical: 'unknown', status: 'REJECTED' })
      .inc(records.length);
    return NextResponse.json(
      {
        status: 'REJECTED',
        message: 'Payload contained syntax validation errors.',
        errors: validationErrors,
      },
      { status: 422 },
    );
  }

  // ── 3 · Hold-trigger detection (UNCLAIMED_IDENTIFIER_HOLD) ────────────
  // Records with no cross-links still ingest (syntax-valid) but route to
  // the hold — the detection rides the post-commit event payload for the
  // PR 53 escrow/registry-ping flow.
  const holds = detectIdentifierHolds(records);
  if (holds.length > 0) {
    logger.warn(
      { tenantId, holds: holds.length },
      'batch contains UNCLAIMED_IDENTIFIER_HOLD records',
    );
  }

  // ── 4 · Phase-2 transactional upserts (all-or-nothing) + post-commit ──
  try {
    const result = await applyIngestionBatch(getDbPool(), tenantId, records, {
      holds,
    });
    if (result.eventJobId === null) {
      logger.warn(
        { tenantId },
        'post-commit event emission did not fire (no database or emission failure) — committed batch stands',
      );
    }

    // ── 5 · Observability (canon v27) ────────────────────────────────────
    // Mixed verticals count per record under its own vertical label; a
    // single-vertical batch counts once at batch size.
    const verticals = new Set(records.map((record) => record.verticalCategory));
    if (verticals.size === 1) {
      ingestionCounter
        .labels({ vertical: records[0].verticalCategory, status: 'SUCCESS' })
        .inc(records.length);
    } else {
      records.forEach((record) =>
        ingestionCounter
          .labels({ vertical: record.verticalCategory, status: 'SUCCESS' })
          .inc(1),
      );
    }
    logger.info(
      { tenantId, count: records.length, eventJobId: result.eventJobId },
      'Successfully ingested batch',
    );

    return NextResponse.json({
      status: 'SUCCESS',
      processedRecords: result.processedRecords,
      tenantId,
    });
  } catch (dbError) {
    ingestionCounter
      .labels({ vertical: 'unknown', status: 'DATABASE_ERROR' })
      .inc(records.length);
    return NextResponse.json(
      {
        status: 'DATABASE_ERROR',
        message: 'Failed to complete transactional bulk insert.',
        details: dbError instanceof Error ? dbError.message : String(dbError),
      },
      { status: 500 },
    );
  }
}

/**
 * The composed production handler — the canon v24 chain in order:
 * authenticateJWT → requireRole → sliding-window limiter → core.
 */
export async function POST(request: Request): Promise<NextResponse> {
  // ── 1 · authenticateJWT (canon v24) ─────────────────────────────────────
  const auth = authenticateJWT(request);
  if (!auth.ok) {
    return NextResponse.json(await auth.response.json(), {
      status: auth.response.status,
    });
  }

  // ── 2 · requireRole (canon v24) ─────────────────────────────────────────
  const role = requireRole(auth.user, ENGINE_INGEST_ROLES);
  if (!role.ok) {
    return NextResponse.json(await role.response.json(), {
      status: role.response.status,
    });
  }

  // ── 3 · Redis sliding-window rate limit (canon v22) ─────────────────────
  const limit = await redisSlidingWindowRateLimiter(
    request,
    IDENTIFIER_INGEST_RATE_LIMIT,
  );
  if (!limit.ok) {
    ingestionCounter
      .labels({ vertical: 'unknown', status: 'RATE_LIMITED' })
      .inc(1);
    return NextResponse.json(
      { ...RATE_LIMIT_EXCEEDED_BODY, retryAfterSeconds: limit.retryAfterSeconds },
      {
        status: 429,
        headers: rateHeaders(IDENTIFIER_INGEST_RATE_LIMIT.maxRequests, 0),
      },
    );
  }
  const okHeaders = rateHeaders(
    IDENTIFIER_INGEST_RATE_LIMIT.maxRequests,
    IDENTIFIER_INGEST_RATE_LIMIT.maxRequests - limit.requestCount,
  );

  // ── 4+ · The core (structural + syntax gates, Phase 2, post-commit) ─────
  const response = await ingestBatch(request);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(okHeaders)) {
    headers.set(key, value);
  }
  return new NextResponse(response.body, {
    status: response.status,
    headers,
  });
}
