import { describe, it, expect, vi } from 'vitest';
import { GET } from '../route';

/**
 * GET /api/ledger contract tests (memory mode).
 *
 * In the CI environment no Supabase credentials are configured, so the route
 * must serve `mode: 'memory'` from the ledger store's in-memory index with a
 * consistent zeroed totals object and never throw. DB-mode read behavior is
 * the store's own concern (covered by the ledger store tests against the
 * deny-all RLS contract in 0001_covenant_init.sql).
 *
 * The gate is mocked AUTHORIZED here — these tests pin the ledger PAYLOAD
 * contract for an authorized caller. The gate's own refusals (401 anonymous,
 * 403 unregistered) are pinned in src/lib/server/__tests__/authz-gates.test.ts.
 */
vi.mock('@/lib/server/apiAccess', () => ({
  requireRegisteredOrOperator: async () => ({ ok: true, role: 'owner' as const }),
}));

const authedGet = (): Promise<Response> => GET(new Request('http://localhost/api/ledger'));

describe('GET /api/ledger', () => {
  it('serves the ledger in memory mode with consistent totals', async () => {
    const res = await authedGet();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('memory');
    expect(typeof body.rlsContract).toBe('string');
    expect(body.rlsContract).toContain('in-memory fallback');
    expect(Array.isArray(body.settlements)).toBe(true);
    expect(body.settlements).toHaveLength(0);
    expect(body.totals).toEqual({ count: 0, gross: 0, fees: 0, cornerDust: 0 });
  });
});
