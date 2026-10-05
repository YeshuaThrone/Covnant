/**
 * /contracts/[id]/export gate tests — the vault's agreement-text download.
 *
 * The gate boundary is REAL (the demo door predicate and the operator's
 * HMAC cookie verify through their production modules) and only the
 * Supabase session resolver is mocked (its own suite covers the resolver —
 * the same seam split the authz-gates battery uses). Pinned:
 *   - configured mode (demo door closed): anonymous 401 no_session with
 *     the sibling error envelope — even for an EXISTING id, proving the
 *     gate precedes the store read and never leaks existence; unenrolled
 *     session 403 not_registered; the operator cookie passes; a registered
 *     holder session gets the attachment with Content-Disposition intact;
 *   - demo door open (dev seed mode AND no Supabase): the sessionless
 *     seeded preview still exports the seeded demo contracts.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// The session seam — mock the resolver per test; the real module shape is
// preserved so the route's SessionCreatorReadError import stays the real
// class (the 502 mapping verifies through it).
vi.mock('@/lib/server/sessionCreator', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/server/sessionCreator')
  >();
  return {
    ...actual,
    resolveSessionCreator: vi.fn(),
  };
});

import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { GET } from '../route';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import { bootDevSeedStore } from '@/lib/server/devSeed';
import { seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { listContracts } from '@/lib/contracts/store';
import type { StoredContract } from '@/lib/contracts/store';

const REGISTERED = {
  kind: 'registered' as const,
  creator: {
    payee_id: 'rh_A',
    stage_name: 'Creator A',
    kyc_status: 'APPROVED',
    bank_account_linked: true,
    provisioning_status: 'PROVISIONED' as const,
  },
};

let demoContract: StoredContract;
let token: string | undefined;

const originalDon = process.env.DON_DEV_SEED;
const originalVercel = process.env.VERCEL_ENV;
const originalPassword = process.env.ADMIN_DASHBOARD_PASSWORD;

/** Configured production posture: every demo-door input off. */
function configuredMode(): void {
  delete process.env.DON_DEV_SEED;
  delete process.env.VERCEL_ENV;
}

function exportRequest(id: string): Request {
  return new Request(`http://localhost/contracts/${id}/export`, {
    headers: token ? { cookie: `${ADMIN_COOKIE_NAME}=${token}` } : {},
  });
}

/** The Next.js handler call shape: the request plus the route context. */
function callExport(id: string): Promise<Response> {
  return GET(exportRequest(id), { params: Promise.resolve({ id }) });
}

beforeAll(async () => {
  // The demo door's own seed path — the seeded agreements the sessionless
  // preview exports (the same store the console's Contracts section reads).
  process.env.DON_DEV_SEED = '1';
  delete process.env.VERCEL_ENV;
  await bootDevSeedStore();
  await seedAdminDemoDataIfEmpty();
  const seeded = await listContracts();
  demoContract = seeded[0];
  expect(demoContract).toBeDefined();
});

afterAll(() => {
  if (originalDon === undefined) delete process.env.DON_DEV_SEED;
  else process.env.DON_DEV_SEED = originalDon;
  if (originalVercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercel;
  if (originalPassword === undefined) delete process.env.ADMIN_DASHBOARD_PASSWORD;
  else process.env.ADMIN_DASHBOARD_PASSWORD = originalPassword;
});

beforeEach(() => {
  configuredMode();
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  token = undefined;
});

afterEach(() => {
  vi.mocked(resolveSessionCreator).mockReset();
});

describe('the export gate in configured mode (demo door closed)', () => {
  it('answers 401 no_session for an unauthenticated request — even for an existing contract id', async () => {
    vi.mocked(resolveSessionCreator).mockResolvedValue({ kind: 'anonymous' });

    const res = await callExport(demoContract.id);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('no_session');
    // The gate precedes the store read: the envelope is the error envelope,
    // never the document.
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('answers 401 for an anonymous request to a nonexistent id (existence is not confirmed either)', async () => {
    vi.mocked(resolveSessionCreator).mockResolvedValue({ kind: 'anonymous' });

    const res = await callExport('CTR-DOESNOTEXIST');
    expect(res.status).toBe(401);
  });

  it('answers 403 not_registered for a signed-in session with no rights-holder enrollment', async () => {
    vi.mocked(resolveSessionCreator).mockResolvedValue({
      kind: 'unregistered',
      reason: 'profile_not_found',
    });

    const res = await callExport(demoContract.id);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('not_registered');
  });

  it('serves the attachment to the operator cookie (the tax export principal)', async () => {
    vi.mocked(resolveSessionCreator).mockResolvedValue({ kind: 'anonymous' });
    process.env.ADMIN_DASHBOARD_PASSWORD = 'test-admin-password-1234';
    token = mintAdminSessionToken()!;

    const res = await callExport(demoContract.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('serves the registered holder session the document with Content-Disposition intact', async () => {
    vi.mocked(resolveSessionCreator).mockResolvedValue(REGISTERED);

    const res = await callExport(demoContract.id);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${demoContract.id}-${demoContract.templateId}.txt"`,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(demoContract.document);
  });

  it('maps a session-resolver read failure to 502 fail-closed, never a document', async () => {
    const { SessionCreatorReadError } = await import('@/lib/server/sessionCreator');
    vi.mocked(resolveSessionCreator).mockRejectedValue(
      new SessionCreatorReadError('registry_read_failed', 'Failed to load the creator registry.'),
    );

    const res = await callExport(demoContract.id);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('registry_read_failed');
  });
});

describe('the demo door (dev seed mode AND no Supabase configured)', () => {
  it('exports the seeded demo contracts sessionless', async () => {
    process.env.DON_DEV_SEED = '1';
    // The resolver answers anonymous AND no cookie is sent — if the route
    // consulted the session at all on the demo door, this would 401.
    vi.mocked(resolveSessionCreator).mockResolvedValue({ kind: 'anonymous' });

    const res = await callExport(demoContract.id);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${demoContract.id}-${demoContract.templateId}.txt"`,
    );
    expect(await res.text()).toBe(demoContract.document);
  });

  it('still answers 404 honestly for an id the demo store does not hold', async () => {
    process.env.DON_DEV_SEED = '1';
    vi.mocked(resolveSessionCreator).mockResolvedValue({ kind: 'anonymous' });

    const res = await callExport('CTR-DOESNOTEXIST');
    expect(res.status).toBe(404);
  });
});
