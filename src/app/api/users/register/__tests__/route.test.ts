import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { resolveDataSourceMode } from '@/lib/data-source';
import { supabaseFromEnv } from '@/lib/supabase';
import { resetGatewayMemoryState } from '@/lib/gateway/telemetry';
import { POST } from '../route';

/**
 * POST /api/users/register route tests. The data-source seam is mocked at the
 * module boundary so the route's own wiring — bearer extraction, JWT
 * verification order, payload validation, camel→snake mapping, persistence —
 * is what gets exercised in both data modes.
 */

vi.mock('@/lib/data-source', () => ({ resolveDataSourceMode: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const modeMock = resolveDataSourceMode as Mock;
const fromEnvMock = supabaseFromEnv as Mock;

function makeBearerRequest(body: unknown, token = 'valid-access-token'): Request {
  return new Request('http://localhost:3000/api/users/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const validPayload = {
  legalName: 'Yeshua Throne',
  artistName: 'Throne',
  regularEmail: 'creator@covnant.test',
  businessEmail: 'biz@covnant.test',
  phone: '+12125550134',
  phoneVerified: true,
};

interface FakeDb {
  client: unknown;
  from: Mock;
  insert: Mock;
}

function makeFakeDb(overrides: { getUserError?: Error; insertError?: Error } = {}): FakeDb {
  const insert = vi.fn().mockResolvedValue({ data: null, error: overrides.insertError ?? null });
  const from = vi.fn().mockImplementation(() => ({ insert }));
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue(
        overrides.getUserError
          ? { data: { user: null }, error: overrides.getUserError }
          : { data: { user: { id: 'auth-user-1' } }, error: null }
      ),
    },
    from,
  };
  return { client, from, insert };
}

describe('POST /api/users/register', () => {
  beforeEach(() => {
    resetGatewayMemoryState();
    modeMock.mockReset();
    fromEnvMock.mockReset();
  });

  it('returns 401 when no Authorization header is present', async () => {
    modeMock.mockReturnValue('memory');
    const request = new Request('http://localhost:3000/api/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload),
    });

    const res = await POST(request);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' });
  });

  it('returns 401 when the Authorization header is not a Bearer token', async () => {
    modeMock.mockReturnValue('memory');
    const request = new Request('http://localhost:3000/api/users/register', {
      method: 'POST',
      headers: { Authorization: 'Basic abc123' },
      body: JSON.stringify(validPayload),
    });

    const res = await POST(request);
    expect(res.status).toBe(401);
  });

  it('returns 401 when Supabase rejects the access token', async () => {
    modeMock.mockReturnValue('supabase');
    const { client } = makeFakeDb({ getUserError: new Error('invalid jwt') });
    fromEnvMock.mockReturnValue(client);

    const res = await POST(makeBearerRequest(validPayload));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'Unauthorized' });
  });

  it('returns 400 when the payload fails validation', async () => {
    modeMock.mockReturnValue('memory');

    const res = await POST(makeBearerRequest({ ...validPayload, phone: 'not-a-phone' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Invalid registration payload/);
  });

  it('maps the camelCase payload to snake_case and inserts creator telemetry via the mocked client', async () => {
    modeMock.mockReturnValue('supabase');
    const { client, from, insert } = makeFakeDb();
    fromEnvMock.mockReturnValue(client);

    const res = await POST(makeBearerRequest(validPayload));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('supabase');
    expect(body.record.authUserId).toBe('auth-user-1');
    expect(from).toHaveBeenCalledWith('creator_telemetry');
    expect(insert).toHaveBeenCalledWith([
      {
        auth_user_id: 'auth-user-1',
        legal_name: 'Yeshua Throne',
        artist_name: 'Throne',
        regular_email: 'creator@covnant.test',
        business_email: 'biz@covnant.test',
        phone: '+12125550134',
        phone_verified: true,
        verified_at: expect.any(String),
      },
    ]);
  });

  it('returns 500 when the telemetry insert fails', async () => {
    modeMock.mockReturnValue('supabase');
    const { client } = makeFakeDb({ insertError: new Error('insert failed') });
    fromEnvMock.mockReturnValue(client);

    const res = await POST(makeBearerRequest(validPayload));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'Failed to persist creator telemetry' });
  });

  it('persists into the in-memory fallback when no Supabase client is configured', async () => {
    modeMock.mockReturnValue('memory');
    fromEnvMock.mockReturnValue(undefined);

    const res = await POST(makeBearerRequest(validPayload));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Memory mode treats the bearer as an opaque local session id; the
    // store's env seam returns no client, so nothing persists beyond the index.
    expect(body.mode).toBe('memory');
    expect(body.record.authUserId).toBe('valid-access-token');
  });
});
