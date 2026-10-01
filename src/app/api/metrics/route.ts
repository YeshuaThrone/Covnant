/**
 * GET /api/metrics — Prometheus scrape endpoint.
 *
 * Canon v27 completion: the founder's observability module collects metrics
 * (default engine set + identifier_ingestion_total) but never exposes them;
 * this route serves the register in the Prometheus text exposition format.
 */

import { register } from '@/lib/observability/ingestionMetrics';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return new Response(await register.metrics(), {
    status: 200,
    headers: { 'Content-Type': register.contentType },
  });
}
