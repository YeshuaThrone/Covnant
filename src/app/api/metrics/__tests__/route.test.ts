/**
 * Metrics route tests — hit the REAL prom-client register (no mocks): the
 * route must expose the custom counter alongside the engine default set.
 */

import { describe, expect, it } from 'vitest';

import { GET } from '../route';

describe('GET /api/metrics (canon v27 completion)', () => {
  it('serves the Prometheus text exposition format', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('exposes the identifier_ingestion_total counter', async () => {
    const res = await GET();
    const body = await res.text();
    expect(body).toContain('identifier_ingestion_total');
    expect(body).toContain('# TYPE identifier_ingestion_total counter');
  });

  it('exposes the engine default metrics under the founder prefix', async () => {
    const res = await GET();
    const body = await res.text();
    expect(body).toContain('global_identifier_engine_process_cpu_seconds_total');
  });
});
