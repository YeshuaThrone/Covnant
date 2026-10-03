/**
 * Telemetry ingestion worker — standalone entry (npm run worker:telemetry).
 *
 * Runs the BullMQ telemetry-ingestion-queue consumer (canon v20's implied
 * Worker): every accepted telemetry-stream webhook batch flows through
 * processTelemetryJob — the shared Phase-2 transactional upserts, the
 * post-commit cache invalidation, and the royalty_recon_jobs event seam.
 * SIGINT/SIGTERM close the worker gracefully (in-flight jobs finish;
 * BullMQ re-delivers anything left).
 */

import { buildTelemetryWorker } from './telemetryWorker';

async function main(): Promise<void> {
  const worker = buildTelemetryWorker();

  worker.on('completed', (job) => {
    console.log(`[telemetry-worker] job ${job.id} completed`);
  });
  worker.on('failed', (job, error) => {
    console.error(`[telemetry-worker] job ${job?.id ?? '?'} failed:`, error);
  });

  const stop = async (signal: string): Promise<void> => {
    console.log(`[telemetry-worker] ${signal} — closing worker`);
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  console.log('[telemetry-worker] telemetry-ingestion-queue consumer running');
}

main().catch((error) => {
  console.error('[telemetry-worker] fatal:', error);
  process.exitCode = 1;
});
