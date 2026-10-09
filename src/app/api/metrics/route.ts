/**
 * GET /api/metrics — Prometheus scrape endpoint.
 *
 * Canon v27 completion: the founder's observability module collects metrics
 * (default engine set + identifier_ingestion_total) but never exposes them;
 * this route serves the register in the Prometheus text exposition format.
 *
 * GATED (bug hunt N2): the Prometheus register is operational surface, not
 * public data — an open scrape endpoint hands every visitor process and
 * traffic shape for free. The read requires a bearer token from
 * METRICS_BEARER_TOKEN, fail-closed: an unset or empty secret answers 401
 * (the endpoint is unavailable, never open) and a missing or mismatched
 * token answers 401. Comparison is constant-time — the admin gate's
 * HMAC-normalized timingSafeEqual pattern — and no failure response
 * carries register data.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { register } from '@/lib/observability/ingestionMetrics';
import { jsonError } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Key domain-separates this compare from any other HMAC use of a fixed key. */
const METRICS_BEARER_DOMAIN = 'covnant-metrics-bearer';

function hmac(payload: string): string {
  return createHmac('sha256', METRICS_BEARER_DOMAIN).update(payload).digest('hex');
}

/** Constant-time token compare — HMAC normalization equalizes buffer lengths. */
function bearerTokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(hmac(presented), 'utf8'), Buffer.from(hmac(expected), 'utf8'));
}

/** The presented bearer credential, or null when the header is absent or not a bearer token. */
function presentedBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  return header !== null && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.METRICS_BEARER_TOKEN;
  const presented = presentedBearerToken(request);
  if (!expected || presented === null || !bearerTokenMatches(presented, expected)) {
    return jsonError(401, 'metrics_unauthorized', 'Metrics require a valid bearer token.');
  }

  return new Response(await register.metrics(), {
    status: 200,
    headers: { 'Content-Type': register.contentType },
  });
}
