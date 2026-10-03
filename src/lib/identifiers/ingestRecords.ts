/**
 * Phase-2 transactional ingestion — the v13 bulk upsert shared by the
 * batch-ingest route (sync path) and the telemetry-stream BullMQ worker
 * (async path, canon v20 Section 1 consumer). ONE implementation of the
 * founder contract so the two paths cannot drift:
 *
 *   BEGIN
 *   → upsert primary into universal_identity_map
 *       ON CONFLICT (primary_code_type, primary_code_value)
 *       DO UPDATE SET vertical_category = EXCLUDED.vertical_category,
 *                     created_at = NOW()            (founder v13, flagged)
 *       RETURNING map_id
 *   → upsert each cross-reference into global_identifier_cross_ref
 *       ON CONFLICT (map_id, linked_code_type, linked_code_value)
 *       DO UPDATE SET verification_source = EXCLUDED.verification_source,
 *                     verified_at = NOW()           (founder v13, flagged)
 *   COMMIT
 *
 * Post-commit event seam (the diagram is law — v13 gap correction): after
 * COMMIT the batch emits its event via the royalty_recon_jobs enqueue path
 * (ONE pending recon row — the UCT enqueue contract), carrying the batch
 * outcome and any UNCLAIMED_IDENTIFIER_HOLD detections for the PR 53
 * registry-ping release flow. Post-commit cache invalidation (v16 gap
 * correction, flagged) DELs each primary code's id_map key so a conflicted
 * vertical_category change cannot serve a stale 24h cache entry.
 *
 * Hardening lessons applied: no id in the upsert conflict payloads (the
 * 0032 lesson); the cross-ref insert keys the RETURNING map_id from the
 * canon composite (0012's unique_code_per_type); event-emission and
 * invalidation failures after COMMIT are surfaced loudly (logged, never
 * swallowed) but never retro-fail an already-committed batch.
 */

import type { Pool, PoolClient } from 'pg';

import { getDb } from '@/lib/db';

import type { IdentityIngestionPayload } from './globalIdentifiers';
import { invalidateResolvedGlobalIdentifier } from './resolveGlobalIdentifier';

export interface IngestionEventPayload {
  event: 'identifier.batch_ingested';
  tenantId: string;
  providerId: string | null;
  processedRecords: number;
  holds: Array<{ index: number; holdReason: string; detail: string }>;
}

export interface IngestionApplyResult {
  processedRecords: number;
  /** The post-commit event row's id, or null when the emission did not fire. */
  eventJobId: string | null;
}

export interface ApplyIngestionOptions {
  providerId?: string | null;
  holds?: IngestionEventPayload['holds'];
}

/** The founder v13 upsert for one primary record + its cross-references. */
async function upsertRecord(
  client: PoolClient,
  record: IdentityIngestionPayload,
): Promise<void> {
  const primary = await client.query(
    `INSERT INTO universal_identity_map
         (entity_id, vertical_category, primary_code_type, primary_code_value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (primary_code_type, primary_code_value)
     DO UPDATE SET vertical_category = EXCLUDED.vertical_category,
                   created_at = NOW()
     RETURNING map_id`,
    [
      record.entityId,
      record.verticalCategory,
      record.primaryCodeType,
      record.primaryCodeValue,
    ],
  );
  const mapId: string | undefined = primary.rows[0]?.map_id;

  for (const xref of record.crossReferences ?? []) {
    await client.query(
      `INSERT INTO global_identifier_cross_ref
           (map_id, linked_code_type, linked_code_value, verification_source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (map_id, linked_code_type, linked_code_value)
       DO UPDATE SET verification_source = EXCLUDED.verification_source,
                     verified_at = NOW()`,
      [mapId, xref.linkedCodeType, xref.linkedCodeValue, xref.verificationSource],
    );
  }
}

/**
 * Run the founder Phase 2 for a whole batch: one transaction, all-or-nothing.
 * Throws on any database error — the route maps that to 500 DATABASE_ERROR
 * (after the rollback); the telemetry worker marks the BullMQ job failed
 * and its attempts/backoff retry budget takes over (canon v20).
 */
export async function applyIngestionBatch(
  pool: Pool,
  tenantId: string,
  records: IdentityIngestionPayload[],
  options: ApplyIngestionOptions = {},
): Promise<IngestionApplyResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const record of records) {
      await upsertRecord(client, record);
    }
    await client.query('COMMIT');
  } catch (dbError) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Surface without masking the original database error.
      console.error('ROLLBACK failed after ingestion error:', rollbackError);
    }
    throw dbError;
  } finally {
    client.release();
  }

  // ── Post-commit seam (never retro-fails the committed batch) ────────────
  await invalidateCommittedCodes(records);
  const eventJobId = await emitIngestionEvent(tenantId, records, options);
  return { processedRecords: records.length, eventJobId };
}

/**
 * Post-commit cache invalidation (v16 gap correction): DEL the id_map key
 * for every DISTINCT primary code in the committed batch. Fail-open —
 * resolveGlobalIdentifier's factory returns null without REDIS_URL and the
 * 24h TTL bounds staleness even when the DEL fails.
 */
async function invalidateCommittedCodes(
  records: IdentityIngestionPayload[],
): Promise<void> {
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.primaryCodeType}:${record.primaryCodeValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await invalidateResolvedGlobalIdentifier(
      record.primaryCodeType,
      record.primaryCodeValue,
    );
  }
}

/**
 * Post-commit event emission via the royalty_recon_jobs enqueue seam (the
 * v13 diagram: "transaction commit 200 OK → event bus"; the platform's
 * event bus IS the recon queue — UCT enqueues with ONE insert, the CVT
 * worker claims). SOURCE FLAG (carried in the PR body): the 0011 column
 * comment pins the source vocabulary to the statement_ingests vocab
 * ('statement' | 'manual'); the engine's event row uses 'identifier_ingest'
 * — the column is unconstrained text and the CVT worker keys on status,
 * but the vocabulary addition is flagged for founder confirmation.
 * Fail-open: a failed emission is logged (never swallowed) and surfaces as
 * eventJobId=null — the committed data stands on its own.
 */
export async function emitIngestionEvent(
  tenantId: string,
  records: IdentityIngestionPayload[],
  options: ApplyIngestionOptions = {},
): Promise<string | null> {
  const event: IngestionEventPayload = {
    event: 'identifier.batch_ingested',
    tenantId,
    providerId: options.providerId ?? null,
    processedRecords: records.length,
    holds: options.holds ?? [],
  };
  try {
    const db = getDb();
    if (db === null) {
      // No DATABASE_URL (unit/CI unit-scope) — nothing to emit to.
      console.warn(
        '[identifier-engine] event emission skipped: no database configured',
      );
      return null;
    }
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO royalty_recon_jobs (status, source, result)
       VALUES ('pending', 'identifier_ingest', $1)
       RETURNING id`,
      [JSON.stringify(event)],
    );
    return inserted.rows[0]?.id ?? null;
  } catch (error) {
    // Never swallow, never retro-fail the committed batch.
    console.error('[identifier-engine] post-commit event emission failed:', error);
    return null;
  }
}
