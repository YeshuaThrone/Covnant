/**
 * POST /api/v1/identifiers/batch-ingest — Universal Registry Identity Batch
 * Ingestion (founder v13 contract, canon v22/v27 extensions).
 *
 * Pipeline per request:
 *   1. Redis sliding-window rate limit (canon v22) — fail-open.
 *   2. Strict structural validation — empty batches are 400 (canon v22
 *      refinement 3: {tenantId, records:[]} is invalid structure).
 *   3. Per-record syntax validation against the live registry (v11/v15/v25) —
 *      any failure rejects the WHOLE batch (422, no partial ingestion).
 *   4. Transactional upserts — uniqueness binds (primary_code_type,
 *      primary_code_value) as a pair (canon v23 Ruling 2, migration 0012).
 *   5. Observability — pino structured log + per-outcome counter (v27).
 */

import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import {
  validateIdentifier,
  type IdentityIngestionPayload,
} from '@/lib/identifiers/globalIdentifiers';
import {
  IDENTIFIER_INGEST_RATE_LIMIT,
  RATE_LIMIT_EXCEEDED_BODY,
  redisSlidingWindowRateLimiter,
} from '@/lib/server/redisRateLimit';
import { ingestionCounter, logger } from '@/lib/observability/ingestionMetrics';

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

export async function POST(request: Request): Promise<NextResponse> {
  // ── 1 · Redis sliding-window rate limit (canon v22) ────────────────────
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

  // ── 2 · Strict structural validation (canon v22 refinement 3) ─────────
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
      { status: 400, headers: okHeaders },
    );
  }

  // ── 3 · Per-record syntax validation (registry v11/v15/v25) ───────────
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
      { status: 422, headers: okHeaders },
    );
  }

  // ── 4 · Transactional upserts (all-or-nothing) ────────────────────────
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    for (const record of records) {
      await client.query(
        `INSERT INTO universal_identity_map
             (entity_id, vertical_category, primary_code_type, primary_code_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (primary_code_type, primary_code_value)
         DO UPDATE SET vertical_category = EXCLUDED.vertical_category`,
        [
          record.entityId,
          record.verticalCategory,
          record.primaryCodeType,
          record.primaryCodeValue,
        ],
      );
      for (const xref of record.crossReferences ?? []) {
        await client.query(
          `INSERT INTO global_identifier_cross_ref
               (map_id, linked_code_type, linked_code_value, verification_source)
           SELECT map_id, $3, $4, $5
             FROM universal_identity_map
            WHERE primary_code_type = $1 AND primary_code_value = $2
           ON CONFLICT (map_id, linked_code_type, linked_code_value)
           DO UPDATE SET verification_source = EXCLUDED.verification_source`,
          [
            record.primaryCodeType,
            record.primaryCodeValue,
            xref.linkedCodeType,
            xref.linkedCodeValue,
            xref.verificationSource,
          ],
        );
      }
    }
    await client.query('COMMIT');

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
      { tenantId, count: records.length },
      'Successfully queued batch ingestion',
    );

    return NextResponse.json(
      { status: 'SUCCESS', processedRecords: records.length, tenantId },
      { status: 200, headers: okHeaders },
    );
  } catch (dbError) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Surface without masking the original database error.
      console.error('ROLLBACK failed after ingestion error:', rollbackError);
    }
    ingestionCounter
      .labels({ vertical: 'unknown', status: 'DATABASE_ERROR' })
      .inc(records.length);
    return NextResponse.json(
      {
        status: 'DATABASE_ERROR',
        message: 'Failed to complete transactional bulk insert.',
        details: dbError instanceof Error ? dbError.message : String(dbError),
      },
      { status: 500, headers: okHeaders },
    );
  } finally {
    client.release();
  }
}
