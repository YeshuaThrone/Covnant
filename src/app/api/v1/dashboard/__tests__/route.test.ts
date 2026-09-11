/**
 * GET /api/v1/dashboard — the failure-code mapping: every session
 * resolution state maps to its named Don code (401 no_session, 404
 * profile_not_found / holder_not_found, 502 read failures with the
 * SessionCreatorReadError code preserved, 503 supabase_not_configured,
 * 429 rate_limited). The seam is mocked here — these tests pin the
 * ROUTE's mapping contract; the resolver and the seeded happy path have
 * their own suites.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../route';
import { SessionCreatorReadError } from '@/lib/server/sessionCreator';
import { DON_API_RATE_LIMIT } from '@/lib/server/rateLimit';
import type { DashboardResolution } from '@/lib/don/dashboardData';

// The dashboard seam — mock loadSessionDashboard per test; the real module
// shape is preserved so unrelated exports stay intact.
vi.mock('@/lib/server/dashboardLive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/dashboardLive')>();
  return {
    ...actual,
    loadSessionDashboard: vi.fn<() => Promise<DashboardResolution>>(),
  };
});

// Supabase reads nothing real in these tests — the environment gate is
// stubbed open so the mocked resolution decides the outcome.
vi.mock('@/lib/server/supabase', () => ({
  readSupabaseEnv: vi.fn(() => ({
    url: 'https://stub.supabase.co',
    serviceRoleKey: 'stub',
    anonKey: 'stub',
  })),
}));

import { loadSessionDashboard } from '@/lib/server/dashboardLive';

function dashboardRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/dashboard');
}

function mockResolution(resolution: DashboardResolution): void {
  vi.mocked(loadSessionDashboard).mockResolvedValue(resolution);
}

beforeEach(() => {
  vi.mocked(loadSessionDashboard).mockReset();
});

describe('GET /api/v1/dashboard — failure-code mapping', () => {
  it('maps anonymous → 401 no_session', async () => {
    mockResolution({ kind: 'anonymous' });
    const response = await GET(dashboardRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'No session — sign in to load the dashboard.',
      code: 'no_session',
    });
  });

  it('maps demo → 401 no_session — the machine contract never serves the seeded demo', async () => {
    // The demo door is the PAGE-facing provider's sessionless fallback; if a
    // demo resolution ever reached this door anyway, it fails CLOSED — the
    // API contract stays session-bound, never serving demo aggregates.
    mockResolution({ kind: 'demo', data: {
      user: { stage_name: 'Nova Reign', initials: 'NR' },
      vault: {
        payee_id: 'rh_nova_reign_don',
        payee_name: 'Nova Reign',
        available_balance: 80_000,
        pending_balance: 247_485,
        reserve_balance: 45_000,
        updated_at: '2026-09-01T00:00:00.000Z',
      },
      ledger: [],
      payouts: [],
      readiness: {
        kyc_status: 'APPROVED',
        tin_verified: 1,
        w9_on_file: 1,
        bank_account_linked: true,
        provisioning_status: 'PROVISIONED',
      },
    } });
    const response = await GET(dashboardRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'No session — sign in to load the dashboard.',
      code: 'no_session',
    });
  });

  it('maps unregistered profile_not_found → 404', async () => {
    mockResolution({ kind: 'unregistered', reason: 'profile_not_found' });
    const response = await GET(dashboardRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'profile_not_found' });
  });

  it('maps unregistered holder_not_found → 404', async () => {
    mockResolution({ kind: 'unregistered', reason: 'holder_not_found' });
    const response = await GET(dashboardRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'holder_not_found' });
  });

  it('maps SessionCreatorReadError to 502 with its code preserved', async () => {
    vi.mocked(loadSessionDashboard).mockRejectedValue(
      new SessionCreatorReadError('registry_read_failed', 'Failed to load the creator registry.'),
    );
    const response = await GET(dashboardRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'registry_read_failed' });
  });

  it('maps an unexpected read failure to 502 dashboard_read_failed (fail closed)', async () => {
    vi.mocked(loadSessionDashboard).mockRejectedValue(new Error('connection reset'));
    const response = await GET(dashboardRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'dashboard_read_failed' });
  });

  it('is rate limited at the Don API limit (429 rate_limited)', async () => {
    mockResolution({ kind: 'anonymous' });
    // One past the limit — the last response is the rejection.
    let lastResponse: Response | undefined;
    for (let i = 0; i < DON_API_RATE_LIMIT.limit + 1; i += 1) {
      lastResponse = await GET(dashboardRequest());
    }
    expect(lastResponse!.status).toBe(429);
    await expect(lastResponse!.json()).resolves.toMatchObject({ code: 'rate_limited' });
  });
});
