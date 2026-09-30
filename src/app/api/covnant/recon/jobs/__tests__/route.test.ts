/**
 * POST /api/covnant/recon/jobs — the UCT layer's enqueue battery (spec
 * art_7M0snhxc, verification rows 2–3).
 *
 * Covers:
 *   - auth: sessionless → 401 no_session, unenrolled → 403 not_registered
 *     (the real operator gate runs and fails closed without an admin
 *     cookie, so every case here rides the creator session path);
 *   - validation: malformed / unknown-source bodies → 422 invalid_recon_job;
 *   - rate limit: the shared limiter's 30-per-minute budget — request 31
 *     is rejected with 429 (both the address and identity budgets share it);
 *   - the ONE-write contract: a valid enqueue returns 202
 *     {ok, job:{id, status:'pending'}}, the row lands in the store with the
 *     verified creator as requested_by, and NOTHING leaves the process —
 *     global fetch is stubbed and asserted never called;
 *   - ingest scoping: a creator naming an ingest_id gets 403
 *     ingest_requires_operator WITHOUT the route confirming or denying the
 *     ingest's existence (no creator linkage column in statement_ingests).
 *
 * The import-boundary walk lives in route.boundary.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/sessionCreator', () => ({ resolveSessionCreator: vi.fn() }));

import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { setStore } from '@/lib/server/store';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { POST } from '../route';

const mockSession = vi.mocked(resolveSessionCreator);

const REGISTERED = {
  kind: 'registered' as const,
  creator: {
    payee_id: '9f3a7c21-1111-4111-8111-111111111111',
    stage_name: 'Aurora Sky',
  },
};

function enqueueRequest(body: unknown): Request {
  return new Request('http://localhost/api/covnant/recon/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
    },
    body: JSON.stringify(body),
  });
}

let store: InMemoryStore;

beforeEach(() => {
  resetRateLimits();
  store = new InMemoryStore();
  setStore(store);
  mockSession.mockResolvedValue(REGISTERED as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  resetRateLimits();
  setStore(null);
});

describe('POST /api/covnant/recon/jobs — auth battery', () => {
  it('rejects a sessionless caller with 401 no_session', async () => {
    mockSession.mockResolvedValue({ kind: 'anonymous' } as never);
    const response = await POST(enqueueRequest({ source: 'statement' }) as never);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('no_session');
  });

  it('rejects a signed-in but unenrolled session with 403 not_registered', async () => {
    mockSession.mockResolvedValue({ kind: 'unregistered' } as never);
    const response = await POST(enqueueRequest({ source: 'statement' }) as never);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('not_registered');
  });
});

describe('POST /api/covnant/recon/jobs — validation and rate limits', () => {
  it('rejects a malformed body with 422 invalid_recon_job', async () => {
    const response = await POST(enqueueRequest({ nope: true }) as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('invalid_recon_job');
  });

  it('rejects an out-of-vocabulary source with 422 — the column must match statement_ingests', async () => {
    const response = await POST(enqueueRequest({ source: 'distrokid' }) as never);
    expect(response.status).toBe(422);
  });

  it('rejects a non-UUID ingest_id with 422', async () => {
    const response = await POST(
      enqueueRequest({ source: 'statement', ingest_id: 'not-a-uuid' }) as never,
    );
    expect(response.status).toBe(422);
  });

  it('rejects request 31 with 429 — the shared per-minute budget', async () => {
    for (let i = 0; i < 30; i++) {
      const response = await POST(enqueueRequest({ source: 'statement' }) as never);
      expect(response.status).toBe(202);
    }
    const overflow = await POST(enqueueRequest({ source: 'statement' }) as never);
    expect(overflow.status).toBe(429);
    const body = (await overflow.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('rate_limited');
  });
});

describe('POST /api/covnant/recon/jobs — the ONE-write contract', () => {
  it('accepts a valid creator enqueue with 202 and stores requested_by from the VERIFIED session', async () => {
    const response = await POST(enqueueRequest({ source: 'statement' }) as never);
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      ok: boolean;
      job: { id: string; status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.job.status).toBe('pending');
    // The same store instance the route wrote through now holds the row.
    const stored = await store.getReconJob(body.job.id);
    expect(stored?.source).toBe('statement');
    expect(stored?.requested_by).toBe(REGISTERED.creator.payee_id);
    expect(stored?.ingest_id).toBeNull();
    expect(stored?.status).toBe('pending');
  });

  it('performs NO outbound fetch in the request cycle', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await POST(enqueueRequest({ source: 'manual' }) as never);
    expect(response.status).toBe(202);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a creator naming an ingest with 403 — never confirming the ingest exists', async () => {
    const response = await POST(
      enqueueRequest({
        source: 'statement',
        ingest_id: '9f3a7c21-2222-4222-8222-222222222222',
      }) as never,
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('ingest_requires_operator');
    // No-existence-disclosure: the message explains the rule, never the lookup.
    expect(body.error).not.toContain('9f3a7c21');
  });
});
