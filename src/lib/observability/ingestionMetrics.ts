/**
 * Engine observability — pino structured logging + Prometheus metrics
 * (canon v27), implemented with singleton guards so Next.js dev hot reload
 * (module re-evaluation) cannot throw 'already registered'.
 *
 * Founder definitions below are character-exact; the guards are the only
 * addition: register.getSingleMetric() lookups re-use an existing metric
 * instance instead of re-registering it.
 *
 * Canon v27 completion (noted in the PR): the founder snippet collects
 * metrics but never exposes them — GET /api/metrics in this PR serves
 * register.metrics() with the Prometheus text content type.
 */

import pino from 'pino';
import client from 'prom-client';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const register = client.register;

// Guard: collectDefaultMetrics registers a fixed metric set under the
// 'global_identifier_engine_' prefix; re-registration on hot reload throws.
// Probe one sentinel metric of that set before collecting.
if (!register.getSingleMetric('global_identifier_engine_process_cpu_seconds_total')) {
  client.collectDefaultMetrics({ prefix: 'global_identifier_engine_' });
}

// Guard: the ingestion counter survives hot reload via getSingleMetric —
// re-use the registered instance if present, otherwise create it.
const registeredCounter = register.getSingleMetric('identifier_ingestion_total');
const ingestionCounter: client.Counter =
  (registeredCounter as client.Counter | undefined) ??
  new client.Counter({
    name: 'identifier_ingestion_total',
    help: 'Total number of records ingested across all verticals',
    labelNames: ['vertical', 'status'],
  });

export { logger, register, ingestionCounter };
