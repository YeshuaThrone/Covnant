/**
 * GET /api/covnant/recon/jobs/[id] — the status-poll battery (spec
 * art_7M0snhxc, verification row 7).
 *
 * requireHolderAccess is mocked at the seam (its own battery lives in
 * src/lib/server/__tests__/authz-gates.test.ts); what is under test here is
 * the route's owner-or-operator contract: an owner reads their own job, a
 * registered creator reading someone else's job and a reader of an unknown
 * id see the SAME 404 (no existence disclosure), and an operator sees any
 * job. The no-store cache header is pinned — a poll must never be cached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/apiAccess', () => ({ requireHolderAccess: vi.fn() }));

import { requireHolderAccess } from '@/lib/server/apiAccess';
import { setStore } from '@/lib/server/store';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { GET } from '../route';

const mockAccess = vi.mocked(requireHolderAccess);

const OWNER_ID = '9f3a7c21-1111-4111-8111-111111111111';
const OTHER_ID = '9f3a7c21-3333-4333-8333-333333333333';

let store: InMemoryStore;
let jobId: string;

beforeEach(async () => {
  store = new InMemoryStore();
  setStore(store);
  const job = await store.createReconJob({ source: 'statement', requested_by: OWNER_ID });
  jobId = job.id;
  mockAccess.mockReset();
});

function getJob(id: string): Request {
  return new Request(`http://localhost/api/covnant/recon/jobs/${id}`);
}

describe('GET /api/covnant/recon/jobs/[id] — owner-or-operator', () => {
  it('returns the job to its owner with no-store caching', async () => {
    mockAccess.mockResolvedValue({ ok: true, role: 'owner', holderId: OWNER_ID });
    const response = await GET(getJob(jobId) as never, {
      params: Promise.resolve({ id: jobId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { ok: boolean; job: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.job.id).toBe(jobId);
  });

  it('returns the job to an operator regardless of requested_by', async () => {
    mockAccess.mockResolvedValue({ ok: true, role: 'operator', holderId: null });
    const response = await GET(getJob(jobId) as never, {
      params: Promise.resolve({ id: jobId }),
    });
    expect(response.status).toBe(200);
  });

  it('gives a foreign creator the SAME 404 an unknown id gets — no enumeration', async () => {
    mockAccess.mockResolvedValue({ ok: true, role: 'owner', holderId: OTHER_ID });
    const foreign = await GET(getJob(jobId) as never, {
      params: Promise.resolve({ id: jobId }),
    });
    const unknown = await GET(getJob(jobId) as never, {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
  });

  it("propagates the access gate's failure envelope untouched", async () => {
    mockAccess.mockResolvedValue({
      ok: false,
      status: 401,
      code: 'no_session',
      message: 'Sign in first.',
    });
    const response = await GET(getJob(jobId) as never, {
      params: Promise.resolve({ id: jobId }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('no_session');
  });
});
