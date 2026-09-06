import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '../route';
import { supabaseFromEnv } from '@/lib/supabase';

/**
 * POST /api/plaid/exchange-token contract tests. Mocks only — no network, no
 * database. fetch is stubbed, supabaseFromEnv is mocked with a fake client
 * that captures the rights_holders upsert payload.
 */

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const mockSupabaseFromEnv = vi.mocked(supabaseFromEnv);

type UpsertPayload = Record<string, unknown>;

function fakeDb() {
  const upserts: UpsertPayload[] = [];
  const db = {
    from: (table: string) => ({
      upsert: (payload: UpsertPayload) => {
        if (table !== 'rights_holders') throw new Error(`unexpected table ${table}`);
        upserts.push(payload);
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { db: db as never, upserts };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/plaid/exchange-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = { publicToken: 'public-sandbox-token', accountId: 'acc_1', rightsHolderId: 'rh_1' };

beforeEach(() => {
  vi.stubEnv('PLAID_CLIENT_ID', 'test-client-id');
  vi.stubEnv('PLAID_SECRET', 'test-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /api/plaid/exchange-token', () => {
  it('returns 400 listing the missing required fields', async () => {
    const res = await POST(postRequest({ publicToken: 'tok' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('accountId');
    expect(body.error).toContain('rightsHolderId');
  });

  it('returns 503 when Plaid credentials are absent', async () => {
    delete process.env.PLAID_CLIENT_ID;
    const { db } = fakeDb();
    mockSupabaseFromEnv.mockReturnValue(db);
    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(503);
  });

  it('returns 503 when Supabase is unconfigured', async () => {
    mockSupabaseFromEnv.mockReturnValue(undefined);
    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(503);
  });

  it('exchanges the token, reads auth numbers, upserts the routing record, and returns the exact payload', async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-sandbox-token', item_id: 'item_1' }))
      .mockResolvedValueOnce(
        jsonResponse({
          accounts: [{ account_id: 'acc_1', mask: '8012', name: 'Checking' }],
          numbers: {
            ach: [{ account_id: 'acc_1', account_number: '1114930198012', routing_number: '011401533' }],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { db, upserts } = fakeDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(200);

    // Both Plaid calls hit production with client credentials in headers and body.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [exchangeCall, authCall] = fetchMock.mock.calls;
    expect(String(exchangeCall[0])).toBe('https://production.plaid.com/item/public_token/exchange');
    const exchangeInit = exchangeCall[1] as RequestInit;
    expect(exchangeInit.headers).toMatchObject({
      'PLAID-CLIENT-ID': 'test-client-id',
      'PLAID-SECRET': 'test-secret',
    });
    expect(JSON.parse(String(exchangeInit.body))).toEqual({
      client_id: 'test-client-id',
      secret: 'test-secret',
      public_token: 'public-sandbox-token',
    });

    expect(String(authCall[0])).toBe('https://production.plaid.com/auth/get');
    expect(JSON.parse(String((authCall[1] as RequestInit).body))).toEqual({
      client_id: 'test-client-id',
      secret: 'test-secret',
      access_token: 'access-sandbox-token',
    });

    // rights_holders upsert: last-4 mask only, never the full account number.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      id: 'rh_1',
      method: 'ACH',
      plaid_access_token: 'access-sandbox-token',
      plaid_account_id: 'acc_1',
      routing_number: '011401533',
      account_number_mask: '8012',
      is_verified: true,
    });
    expect(typeof upserts[0].updated_timestamp).toBe('number');

    // Exact user-locked response shape.
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['ok', 'payoutRouting', 'rightsHolderId']);
    expect(body.ok).toBe(true);
    expect(body.rightsHolderId).toBe('rh_1');
    expect(body.payoutRouting).toEqual({
      method: 'ACH',
      plaidAccessToken: 'access-sandbox-token',
      plaidAccountId: 'acc_1',
      routingNumber: '011401533',
      accountNumberMask: '8012',
      isVerified: true,
      updatedTimestamp: expect.any(Number),
    });
  });

  it('propagates a Plaid exchange failure as a sanitized 502', async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockResolvedValue(jsonResponse({ error: 'bad thing' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const { db, upserts } = fakeDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('bad thing');
    expect(upserts).toHaveLength(0);
  });

  it('propagates a network-level fetch rejection as a sanitized 502', async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const { db } = fakeDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });

  it('returns 502 when Plaid returns no account numbers for the account', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-sandbox-token' }))
      .mockResolvedValueOnce(jsonResponse({ accounts: [], numbers: { ach: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const { db } = fakeDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(502);
  });
});
