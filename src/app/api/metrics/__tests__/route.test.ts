/**
 * Metrics route tests — the bearer gate (bug hunt N2) and the REAL
 * prom-client register (no mocks): the route must fail closed without a
 * configured token, refuse anonymous and mismatched callers, and serve the
 * custom counter alongside the engine default set to a token holder.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET } from '../route';

const TOKEN = 'metrics-scrape-token';
let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.METRICS_BEARER_TOKEN;
  delete process.env.METRICS_BEARER_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.METRICS_BEARER_TOKEN;
  else process.env.METRICS_BEARER_TOKEN = savedToken;
});

function scrape(authorization?: string): Request {
  return new Request('http://localhost/api/metrics', {
    headers: authorization ? { authorization } : {},
  });
}

describe('GET /api/metrics — bearer-gated Prometheus surface', () => {
  it('401 when METRICS_BEARER_TOKEN is unset — fail closed', async () => {
    const res = await GET(scrape());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('metrics_unauthorized');
  });

  it('401 with no Authorization header even when a token is configured', async () => {
    process.env.METRICS_BEARER_TOKEN = TOKEN;
    const res = await GET(scrape());
    expect(res.status).toBe(401);
  });

  it('401 with a mismatched bearer token', async () => {
    process.env.METRICS_BEARER_TOKEN = TOKEN;
    const res = await GET(scrape('Bearer wrong-token'));
    expect(res.status).toBe(401);
  });

  it('401 when the Authorization header is not a bearer credential', async () => {
    process.env.METRICS_BEARER_TOKEN = TOKEN;
    const res = await GET(scrape(TOKEN));
    expect(res.status).toBe(401);
  });

  it('200 with the correct bearer token — Prometheus text exposition format', async () => {
    process.env.METRICS_BEARER_TOKEN = TOKEN;
    const res = await GET(scrape(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('identifier_ingestion_total');
    expect(body).toContain('# TYPE identifier_ingestion_total counter');
  });

  it('exposes the engine default metrics under the founder prefix (authenticated)', async () => {
    process.env.METRICS_BEARER_TOKEN = TOKEN;
    const res = await GET(scrape(`Bearer ${TOKEN}`));
    const body = await res.text();
    expect(body).toContain('global_identifier_engine_process_cpu_seconds_total');
  });
});
