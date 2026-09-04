import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { resolveDataSourceMode } from '@/lib/data-source';
import { supabaseFromEnv } from '@/lib/supabase';
import {
  grantMemoryAdmin,
  insertCreatorTelemetry,
  resetGatewayMemoryState,
} from '@/lib/gateway/telemetry';
import { GET } from '../route';

/**
 * GET /api/admin/ledger route tests. The platform-admin check is the gate
 * under test: unauthenticated callers get 401, authenticated non-admins get
 * 403 with no data, and an allowlisted admin fixture gets the records — in
 * both the Supabase and memory data modes.
 */

vi.mock('@/lib/data-source', () => ({ resolveDataSourceMode: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const modeMock = resolveDataSourceMode as Mock;
const fromEnvMock = supabaseFromEnv as Mock;

const ADMIN_ID = 'ceo-user-1';

interface FakeDb {
  client: unknown;
  from: Mock;
}

function makeFakeDb(
  overrides: { getUserError?: Error; adminRows?: unknown[]; telemetryRows?: Record<string, unknown>[] } = {}
): FakeDb {
  const from = vi.fn().mockImplementation((table: string) => {
    const rows =
      table === 'platform_admin_allowlists' ? (overrides.adminRows ?? []) : (overrides.telemetryRows ?? []);
    return {
      select: () => ({
        // platform_admin_allowlists path: select().eq().limit()
        eq: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }),
        // creator_telemetry path: select().order()
        order: () => Promise.resolve({ data: rows, error: null }),
      }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  });
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue(
        overrides.getUserError
          ? { data: { user: null }, error: overrides.getUserError }
          : { data: { user: { id: ADMIN_ID } }, error: null }
      ),
    },
    from,
  };
  return { client, from };
}

function makeGetRequest(token = 'admin-session-token'): Request {
  return new Request('http://localhost:3000/api/admin/ledger', {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

const telemetryRow = {
  id: 'telemetry-1',
  auth_user_id: 'creator-1',
  legal_name: 'Yeshua Throne',
  artist_name: 'Throne',
  regular_email: 'creator@covnant.test',
  business_email: 'biz@covnant.test',
  phone: '+12125550134',
  phone_verified: true,
  verified_at: '2026-09-04T00:00:00.000Z',
  created_at: '2026-09-04T00:00:00.000Z',
};

describe('GET /api/admin/ledger', () => {
  beforeEach(() => {
    resetGatewayMemoryState();
    modeMock.mockReset();
    fromEnvMock.mockReset();
  });

  it('returns 401 when no Authorization header is present', async () => {
    modeMock.mockReturnValue('memory');

    const res = await GET(makeGetRequest(''));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' });
  });

  it('returns 401 when Supabase rejects the caller token', async () => {
    modeMock.mockReturnValue('supabase');
    const { client } = makeFakeDb({ getUserError: new Error('expired') });
    fromEnvMock.mockReturnValue(client);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' });
  });

  it('returns 403 with no records for an authenticated non-admin', async () => {
    modeMock.mockReturnValue('supabase');
    const { client, from } = makeFakeDb({ adminRows: [], telemetryRows: [telemetryRow] });
    fromEnvMock.mockReturnValue(client);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    expect(body.records).toBeUndefined();
    // The telemetry table is never read when the admin gate fails.
    expect(from.mock.calls.flat()).not.toContain('creator_telemetry');
  });

  it('returns the records for an allowlisted admin (Supabase mode)', async () => {
    modeMock.mockReturnValue('supabase');
    const { client, from } = makeFakeDb({
      adminRows: [{ id: 'allow-1' }],
      telemetryRows: [telemetryRow],
    });
    fromEnvMock.mockReturnValue(client);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.records).toEqual([
      {
        id: 'telemetry-1',
        authUserId: 'creator-1',
        legalName: 'Yeshua Throne',
        artistName: 'Throne',
        regularEmail: 'creator@covnant.test',
        businessEmail: 'biz@covnant.test',
        phone: '+12125550134',
        phoneVerified: true,
        verifiedAt: '2026-09-04T00:00:00.000Z',
      },
    ]);
    // Admin determination queried the platform_admin_allowlists table.
    expect(from.mock.calls.flat()).toContain('platform_admin_allowlists');
    expect(from.mock.calls.flat()).toContain('creator_telemetry');
  });

  it('serves the memory index for a memory-mode admin fixture', async () => {
    modeMock.mockReturnValue('memory');
    fromEnvMock.mockReturnValue(undefined);
    grantMemoryAdmin('admin-session-token');
    await insertCreatorTelemetry(
      {
        authUserId: 'creator-1',
        legalName: 'Yeshua Throne',
        artistName: 'Throne',
        regularEmail: 'creator@covnant.test',
        businessEmail: undefined,
        phone: '+12125550134',
        phoneVerified: true,
        verifiedAt: '2026-09-04T00:00:00.000Z',
      },
      undefined
    );

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      authUserId: 'creator-1',
      legalName: 'Yeshua Throne',
      phoneVerified: true,
    });
  });

  it('rejects a non-admin in memory mode', async () => {
    modeMock.mockReturnValue('memory');
    fromEnvMock.mockReturnValue(undefined);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'Forbidden' });
  });
});
