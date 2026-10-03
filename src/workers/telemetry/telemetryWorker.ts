/**
 * Telemetry ingestion worker — the implied BullMQ consumer on the
 * telemetry-ingestion-queue (founder canon v20 Section 1: "the founder
 * draft imports Worker but omits the consumer"). This is the async twin
 * of the v13 batch-ingest Phase 2: every accepted 202 webhook batch lands
 * here and runs the SAME shared transactional upserts as the sync route
 * (applyIngestionBatch — universal_identity_map primaries with
 * created_at = NOW() on conflict, global_identifier_cross_ref with
 * verified_at = NOW()), the post-commit cache invalidation (v16), and the
 * post-commit royalty_recon_jobs event seam (v13 diagram, gap correction).
 *
 * Runtime: a standalone tsx process (npm run worker:telemetry) per the PR 2
 * worker runtime model — Vercel serverless cannot host long-running
 * workers. Attempts (3) and exponential backoff (1000ms) are declared at
 * enqueue time (canon v20); a job that exhausts its attempts stays failed
 * in BullMQ with its error — never silent.
 *
 * FLAG (PR body): the telemetry payload carries providerId, not tenantId —
 * the post-commit event's tenant binding uses providerId (the provider IS
 * the tenant in the telemetry space). Founder to confirm.
 */

import { Worker, type Job } from 'bullmq';
import { Pool } from 'pg';

import type { IdentityIngestionPayload } from '@/lib/identifiers/globalIdentifiers';
import { detectIdentifierHolds } from '@/lib/identifiers/identifierHolds';
import {
  applyIngestionBatch,
  type IngestionEventPayload,
} from '@/lib/identifiers/ingestRecords';
import { logger } from '@/lib/observability/ingestionMetrics';

/** The BullMQ job body the v20 webhook enqueues. */
export interface TelemetryJobData {
  providerId: string;
  records: IdentityIngestionPayload[];
  timestamp: string;
}

/** Lazy pool — DATABASE_URL read at first use (house convention of src/lib/db.ts). */
let dbPool: Pool | null = null;

function getDbPool(): Pool {
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return dbPool;
}

/** Test-only: drop the cached pool so a later use reconnects. */
export function resetTelemetryWorkerPool(): void {
  dbPool = null;
}

/** The Phase-2 processor the Worker runs per telemetry job. */
export async function processTelemetryJob(job: Job): Promise<{
  processedRecords: number;
  eventJobId: string | null;
  holds: IngestionEventPayload['holds'];
}> {
  const data = job.data as TelemetryJobData;
  const { providerId, records, timestamp } = data;
  if (!providerId || !Array.isArray(records)) {
    // A malformed job body cannot be retried into validity — fail the job
    // with the reason (BullMQ marks it failed after attempts; nothing silent).
    throw new Error('malformed_telemetry_job_body');
  }
  const holds = detectIdentifierHolds(records);
  logger.info(
    { providerId, count: records.length, enqueuedAt: timestamp },
    'processing telemetry batch',
  );
  const result = await applyIngestionBatch(getDbPool(), providerId, records, {
    providerId,
    holds,
  });
  logger.info(
    {
      providerId,
      count: result.processedRecords,
      eventJobId: result.eventJobId,
    },
    'telemetry batch ingested',
  );
  return { ...result, holds };
}

/**
 * Build the telemetry-ingestion-queue Worker (BullMQ connection from the
 * v16 REDIS_URL convention — same defaults as the webhook's queue).
 */
export function buildTelemetryWorker(): Worker {
  const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  return new Worker('telemetry-ingestion-queue', processTelemetryJob, {
    connection: {
      host: url.hostname,
      port: Number(url.port) || 6379,
      username: url.username || undefined,
      password: url.password || undefined,
      // BullMQ requirement — blocking reads must survive connection drops.
      maxRetriesPerRequest: null,
    },
    concurrency: 5,
  });
}
