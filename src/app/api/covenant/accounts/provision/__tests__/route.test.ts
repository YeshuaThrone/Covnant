import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { getDb } from '@/lib/db';

/**
 * POST /api/covenant/accounts/provision contract tests (CovnantRoyaltyTrackingAPI).
 *
 * Against the authoritative live schema: the holder resolves through the
 * GIN-indexed cbt_assets.rights_holders JSONB (rightsHolderId),
 * provisioning writes the payoutRouting.covenantVirtualAccount block under
 * FOR UPDATE serialization, and the pinned Increase POST /account_numbers
 * call is mocked — no network, no database, no real secrets.
 */

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);

const ASSET_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const HOLDER_ID = 'rh_1';

function holderEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rightsHolderId: HOLDER_ID,
    name: 'Test Holder',
    role: 'COMPOSER',
    payoutRouting: { routingNumber: '021000021', accountNumber: '123456789' },
    ...overrides,
  };
}

function provisionedHolderEntry(): Record<string, unknown> {
  return holderEntry({
    payoutRouting: {
      routingNumber: '021000021',
      accountNumber: '123456789',
      covenantVirtualAccount: {
        accountNumberId: 'account_number_existing',
        accountNumber: '987654321',
        routingNumber: '101050001',
        provisionedAt: '2026-01-01T00:00:00Z',
      },
    },
  });
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/**
 * A db fake whose jsonb holder lookup pops from holderSequence (one entry
 * per transaction — phase 1 then phase 3) and records every query.
 */
function fakeDb(options: { holderSequence?: Array<Record<string, unknown> | null> } = {}) {
  const txQueries: QueryCall[] = [];
  const holderSequence = [...(options.holderSequence ?? [])];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('jsonb_array_elements')) {
      const holder = holderSequence.shift() ?? null;
      return Promise.resolve(holder ? { rows: [{ holder }] } : { rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const tx = { query: txQuery };
  const db = {
    query: vi.fn(),
    transaction: vi.fn(
      async <T>(work: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> => work(tx),
    ),
  };
  return { db, txQueries };
}

function stubIncreaseAccountNumber(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<
    (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  >();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function increaseAccountNumberResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 'account_number_v18nkfqm6afpsrvy82b2',
      account_number: '987654321',
      routing_number: '101050001',
      created_at: '2026-09-07T00:00:00Z',
      status: 'active',
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function provisionRequest(body: unknown): Request {
  return new Request('http://localhost/api/covenant/accounts/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('INCREASE_API_KEY', 'test-increase-key');
  vi.stubEnv('INCREASE_SOURCE_ACCOUNT_ID', 'account_in71c4amph0vgo2qllky');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /api/covenant/accounts/provision', () => {
  describe('request validation', () => {
    it.each([
      ['missing assetId', { rightsHolderId: HOLDER_ID }],
      ['non-UUID assetId', { assetId: 'not-a-uuid', rightsHolderId: HOLDER_ID }],
      ['missing rightsHolderId', { assetId: ASSET_ID }],
      ['blank rightsHolderId', { assetId: ASSET_ID, rightsHolderId: '   ' }],
      ['empty body', {}],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await POST(provisionRequest(body));
      expect(res.status).toBe(400);
      const bodyJson = (await res.json()) as { ok: boolean };
      expect(bodyJson.ok).toBe(false);
    });

    it('rejects a non-JSON body with 400', async () => {
      const res = await POST(provisionRequest('{not-json'));
      expect(res.status).toBe(400);
    });
  });

  describe('environment fail-closed', () => {
    it('returns 503 when INCREASE_API_KEY is unconfigured', async () => {
      vi.stubEnv('INCREASE_API_KEY', '');
      const { db } = fakeDb({ holderSequence: [holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(503);
    });

    it('returns 503 when INCREASE_SOURCE_ACCOUNT_ID is unconfigured', async () => {
      vi.stubEnv('INCREASE_SOURCE_ACCOUNT_ID', '');
      const { db } = fakeDb({ holderSequence: [holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(503);
    });

    it('returns 503 when the database is unconfigured', async () => {
      mockGetDb.mockReturnValue(null);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(503);
    });
  });

  describe('holder resolution', () => {
    it('returns a sanitized 404 for an unknown holder', async () => {
      const { db } = fakeDb({ holderSequence: [null] });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([]);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(404);
      const bodyJson = (await res.json()) as { error: string };
      expect(bodyJson.error).toBe('Rights holder not found.');
      expect(bodyJson.error).not.toContain('database');
    });

    it('resolves the holder through the GIN JSONB lookup with FOR UPDATE', async () => {
      const { db, txQueries } = fakeDb({ holderSequence: [holderEntry(), holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(200);
      const holderSelect = txQueries.find((q) => q.sql.includes('jsonb_array_elements'));
      expect(holderSelect).toBeDefined();
      expect(holderSelect?.sql).toContain("rh->>'rightsHolderId' = $2");
      expect(holderSelect?.sql).toContain('FOR UPDATE');
      expect(holderSelect?.params).toEqual([ASSET_ID, HOLDER_ID]);
    });
  });

  describe('idempotency', () => {
    it('returns the existing virtual account without a duplicate Increase call', async () => {
      const fetchMock = stubIncreaseAccountNumber([]);
      const { db } = fakeDb({ holderSequence: [provisionedHolderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        alreadyProvisioned: boolean;
        accountNumberId: string;
        accountNumber: string;
        routingNumber: string;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        alreadyProvisioned: true,
        accountNumberId: 'account_number_existing',
        accountNumber: '987654321',
        routingNumber: '101050001',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the existing numbers when a concurrent provision wins the row lock', async () => {
      const fetchMock = stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      const { db, txQueries } = fakeDb({
        holderSequence: [holderEntry(), provisionedHolderEntry()],
      });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as { alreadyProvisioned: boolean };
      expect(bodyJson.alreadyProvisioned).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(txQueries.some((q) => q.sql.includes('UPDATE cbt_assets'))).toBe(false);
    });
  });

  describe('provisioning success', () => {
    it('creates the Increase account number with the pinned contract and persists it', async () => {
      const { db, txQueries } = fakeDb({ holderSequence: [holderEntry(), holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        alreadyProvisioned: boolean;
        accountNumberId: string;
        accountNumber: string;
        routingNumber: string;
        provisionedAt: string;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        alreadyProvisioned: false,
        accountNumberId: 'account_number_v18nkfqm6afpsrvy82b2',
        accountNumber: '987654321',
        routingNumber: '101050001',
        provisionedAt: '2026-09-07T00:00:00Z',
      });

      // Pinned Increase Account Number creation contract.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.increase.com/account_numbers');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-increase-key');
      expect(headers['Idempotency-Key']).toBe(`covenant-royalty-tracking:${ASSET_ID}:${HOLDER_ID}`);
      expect(JSON.parse(String(init.body))).toEqual({
        account_id: 'account_in71c4amph0vgo2qllky',
        name: 'Covnant royalty payout',
        inbound_ach: { debit_status: 'blocked' },
      });

      // Persistence: sibling-preserving JSONB rewrite of payoutRouting.
      const update = txQueries.find((q) => q.sql.includes('UPDATE cbt_assets'));
      expect(update).toBeDefined();
      expect(update?.sql).toContain('jsonb_agg');
      expect(update?.sql).toContain('COALESCE');
      expect(update?.sql).toContain('WHERE id = $1');
      expect(update?.params?.[0]).toBe(ASSET_ID);
      expect(update?.params?.[1]).toBe(HOLDER_ID);
      const rewritten = JSON.parse(String(update?.params?.[2])) as {
        rightsHolderId: string;
        name: string;
        payoutRouting: {
          routingNumber: string;
          covenantVirtualAccount: Record<string, string>;
        };
      };
      expect(rewritten.payoutRouting.routingNumber).toBe('021000021');
      expect(rewritten.payoutRouting.covenantVirtualAccount).toEqual({
        accountNumberId: 'account_number_v18nkfqm6afpsrvy82b2',
        accountNumber: '987654321',
        routingNumber: '101050001',
        provisionedAt: '2026-09-07T00:00:00Z',
      });
      expect(rewritten.name).toBe('Test Holder');
    });
  });

  describe('Increase failure handling', () => {
    it('maps an Increase rejection to a retryable 502 without leaking errors', async () => {
      const { db } = fakeDb({ holderSequence: [holderEntry(), holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([new Response('{"error":"nope"}', { status: 500 })]);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(502);
      const bodyJson = (await res.json()) as { error: string };
      expect(bodyJson.error).toBe('Increase account number provisioning failed.');
      expect(bodyJson.error).not.toContain('nope');
    });

    it('maps a malformed Increase response to a retryable 502', async () => {
      const { db } = fakeDb({ holderSequence: [holderEntry(), holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([new Response('{not-json', { status: 200 })]);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(502);
    });

    it('maps an incomplete Increase account number to a retryable 502', async () => {
      const { db } = fakeDb({ holderSequence: [holderEntry(), holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([
        increaseAccountNumberResponse({ routing_number: undefined }),
      ]);
      const res = await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      expect(res.status).toBe(502);
    });
  });

  describe('schema hygiene', () => {
    it('issues no banking-era schema queries (rights_holders table, gross_settled, disbursements)', async () => {
      const { db, txQueries } = fakeDb({ holderSequence: [holderEntry(), holderEntry()] });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      await POST(provisionRequest({ assetId: ASSET_ID, rightsHolderId: HOLDER_ID }));
      const allSql = txQueries.map((q) => q.sql).join('\n');
      expect(allSql).not.toContain('FROM rights_holders');
      expect(allSql).not.toContain('gross_settled');
      expect(allSql).not.toContain('disbursements');
    });
  });
});
