import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { getDb } from '@/lib/db';

/**
 * POST /api/covenant/auth/signup contract tests (instant sign-up).
 *
 * Against the authoritative live schema: the holder is registered in a
 * designated cbt_assets registry row (cbt_code 'CBT-SIGNUP-REGISTRY') with
 * the EXACT PR #26 holder entry shape plus the normalized email identity,
 * then provisioned through the shared core with the pinned Increase
 * POST /account_numbers call mocked — no network, no database, no real
 * secrets. PENDING responses must never carry account/routing numbers.
 */

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);

const EMAIL = 'creator@example.com';
const REGISTRY_ASSET_ID = 'b2c3d4e5-0000-4000-8000-000000000002';

function signupHolderEntry(): Record<string, unknown> {
  return {
    rightsHolderId: 'rh_signup_existing',
    name: EMAIL,
    role: 'COMPOSER',
    email: EMAIL,
    payoutRouting: {},
  };
}

function provisionedHolderEntry(): Record<string, unknown> {
  return {
    ...signupHolderEntry(),
    payoutRouting: {
      covenantVirtualAccount: {
        accountNumberId: 'account_number_existing',
        accountNumber: '987654321',
        routingNumber: '101050001',
        provisionedAt: '2026-01-01T00:00:00Z',
      },
    },
  };
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/**
 * A stateful db fake modeling the registry row: find-or-create via
 * pg_advisory_xact_lock + cbt_code FOR UPDATE + INSERT, holder append via
 * the jsonb concat, and the shared core's jsonb lookups/rewrites. Records
 * every query and exposes the live registry state for assertions.
 */
function fakeDb(options: { registry?: { id: string; rights_holders: unknown[] }; dropAppendedHolder?: boolean } = {}) {
  let registry = options.registry ? { ...options.registry, rights_holders: [...options.registry.rights_holders] } : null;
  const txQueries: QueryCall[] = [];
  const txQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('jsonb_agg')) {
      const holderId = params?.[1];
      const updated = JSON.parse(String(params?.[2]));
      if (registry) {
        registry.rights_holders = registry.rights_holders.map((holder) =>
          (holder as { rightsHolderId?: unknown }).rightsHolderId === holderId ? updated : holder,
        );
      }
      return { rows: [] };
    }
    if (sql.includes('jsonb_array_elements')) {
      const holderId = params?.[1];
      const holder =
        registry?.rights_holders.find(
          (candidate) => (candidate as { rightsHolderId?: unknown }).rightsHolderId === holderId,
        ) ?? null;
      return holder ? { rows: [{ holder }] } : { rows: [] };
    }
    if (sql.includes('cbt_code = $1')) {
      return registry ? { rows: [{ id: registry.id, rights_holders: registry.rights_holders }] } : { rows: [] };
    }
    if (sql.includes('INSERT INTO cbt_assets')) {
      registry = { id: REGISTRY_ASSET_ID, rights_holders: [] };
      return { rows: [{ id: registry.id, rights_holders: [] }] };
    }
    if (sql.includes('|| $2::jsonb')) {
      if (registry && !options.dropAppendedHolder) {
        registry.rights_holders.push(JSON.parse(String(params?.[1])));
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
  const tx = { query: txQuery };
  const db = {
    query: vi.fn(),
    transaction: vi.fn(
      async <T>(work: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> => work(tx),
    ),
  };
  return { db, txQueries, getRegistry: () => registry };
}

function stubIncreaseAccountNumber(responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<
    (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  >();
  for (const response of responses) {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
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

function signupRequest(body: unknown): Request {
  return new Request('http://localhost/api/covenant/auth/signup', {
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

function expectNoAccountNumbers(bodyJson: unknown): void {
  const text = JSON.stringify(bodyJson);
  expect(text).not.toContain('accountNumber');
  expect(text).not.toContain('routingNumber');
  expect(text).not.toContain('987654321');
  expect(text).not.toContain('101050001');
  expect(text).not.toContain('account_number_');
}

describe('POST /api/covenant/auth/signup', () => {
  describe('request validation', () => {
    it.each([
      ['missing email', {}],
      ['blank email', { email: '   ' }],
      ['non-string email', { email: 42 }],
      ['email without @', { email: 'not-an-email' }],
      ['email without a TLD', { email: 'a@b' }],
      ['local part over 64 chars', { email: `${'a'.repeat(65)}@example.com` }],
    ])('rejects %s with 400', async (_label, body) => {
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signupRequest(body));
      expect(res.status).toBe(400);
      const bodyJson = (await res.json()) as { ok: boolean };
      expect(bodyJson.ok).toBe(false);
    });

    it('rejects a non-JSON body with 400', async () => {
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signupRequest('{not-json'));
      expect(res.status).toBe(400);
    });

    it.each([
      ['null body', 'null'],
      ['array body', '["someone@example.com"]'],
    ])('rejects a %s with 400', async (_label, raw) => {
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signupRequest(raw));
      expect(res.status).toBe(400);
      const bodyJson = (await res.json()) as { error: string };
      expect(bodyJson.error).not.toContain('someone@example.com');
    });
  });

  describe('environment fail-closed', () => {
    it('registers the holder and returns 201 PENDING when INCREASE_API_KEY is unconfigured', async () => {
      vi.stubEnv('INCREASE_API_KEY', '');
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        status: string;
        reason?: string;
        alreadyRegistered: boolean;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        status: 'PENDING',
        reason: 'INCREASE_NOT_CONFIGURED',
        alreadyRegistered: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getRegistry()?.rights_holders).toHaveLength(1);
      expectNoAccountNumbers(bodyJson);
    });

    it('registers the holder and returns 201 PENDING when INCREASE_SOURCE_ACCOUNT_ID is unconfigured', async () => {
      vi.stubEnv('INCREASE_SOURCE_ACCOUNT_ID', '');
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as { status: string; reason?: string };
      expect(bodyJson).toMatchObject({ status: 'PENDING', reason: 'INCREASE_NOT_CONFIGURED' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getRegistry()?.rights_holders).toHaveLength(1);
    });

    it('returns a fail-closed 503 when the database is unconfigured', async () => {
      mockGetDb.mockReturnValue(null);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(503);
      const bodyJson = (await res.json()) as { ok: boolean };
      expect(bodyJson.ok).toBe(false);
    });
  });

  describe('happy path', () => {
    it('registers the holder, provisions through Increase, and persists the virtual account', async () => {
      const { db, txQueries, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        status: string;
        alreadyRegistered: boolean;
        rightsHolderId: string;
        assetId: string;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        status: 'PROVISIONED',
        alreadyRegistered: false,
        assetId: REGISTRY_ASSET_ID,
      });
      expect(typeof bodyJson.rightsHolderId).toBe('string');
      expectNoAccountNumbers(bodyJson);

      // Pinned Increase Account Number creation contract (shared core).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.increase.com/account_numbers');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-increase-key');
      expect(headers['Idempotency-Key']).toBe(
        `covenant-royalty-tracking:${REGISTRY_ASSET_ID}:${bodyJson.rightsHolderId}`,
      );
      expect(JSON.parse(String(init.body))).toEqual({
        account_id: 'account_in71c4amph0vgo2qllky',
        name: 'Covnant royalty payout',
        inbound_ach: { debit_status: 'blocked' },
      });

      // The EXACT PR #26 holder entry shape, with the email identity, plus
      // the persisted covenantVirtualAccount block.
      const holders = getRegistry()?.rights_holders ?? [];
      expect(holders).toHaveLength(1);
      const entry = holders[0] as {
        rightsHolderId: string;
        name: string;
        role: string;
        email: string;
        payoutRouting: { covenantVirtualAccount: Record<string, string> };
      };
      expect(entry).toMatchObject({
        rightsHolderId: bodyJson.rightsHolderId,
        name: EMAIL,
        role: 'COMPOSER',
        email: EMAIL,
      });
      expect(entry.payoutRouting.covenantVirtualAccount).toEqual({
        accountNumberId: 'account_number_v18nkfqm6afpsrvy82b2',
        accountNumber: '987654321',
        routingNumber: '101050001',
        provisionedAt: '2026-09-07T00:00:00Z',
      });

      // Zero money movement: no ledger queries anywhere in the flow.
      const allSql = txQueries.map((q) => q.sql).join('\n');
      expect(allSql).not.toContain('universal_royalty_ledger');
      expect(allSql).not.toContain('FROM rights_holders');
      expect(allSql).not.toContain('disbursements');
    });
  });

  describe('idempotency + pending recovery', () => {
    it('returns the existing holder with no duplicate entry on repeat signup', async () => {
      const registry = { id: REGISTRY_ASSET_ID, rights_holders: [signupHolderEntry()] };
      vi.stubEnv('INCREASE_API_KEY', '');
      const { db, getRegistry } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signupRequest({ email: `  ${EMAIL.toUpperCase()}  ` }));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        status: string;
        reason?: string;
        alreadyRegistered: boolean;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        status: 'PENDING',
        reason: 'INCREASE_NOT_CONFIGURED',
        alreadyRegistered: true,
      });
      expect(getRegistry()?.rights_holders).toHaveLength(1);
      expectNoAccountNumbers(bodyJson);
    });

    it('completes pending provisioning when credentials arrive and signup repeats', async () => {
      const registry = { id: REGISTRY_ASSET_ID, rights_holders: [signupHolderEntry()] };
      const { db, getRegistry } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as { status: string; alreadyRegistered: boolean };
      expect(bodyJson).toMatchObject({ status: 'PROVISIONED', alreadyRegistered: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const holders = getRegistry()?.rights_holders ?? [];
      expect(holders).toHaveLength(1);
      const entry = holders[0] as {
        payoutRouting: { covenantVirtualAccount?: Record<string, string> };
      };
      expect(entry.payoutRouting.covenantVirtualAccount).toMatchObject({
        accountNumberId: 'account_number_v18nkfqm6afpsrvy82b2',
      });
      expectNoAccountNumbers(bodyJson);
    });

    it('does not call Increase again when the holder is already provisioned', async () => {
      const registry = { id: REGISTRY_ASSET_ID, rights_holders: [provisionedHolderEntry()] };
      const { db } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as { status: string; alreadyRegistered: boolean };
      expect(bodyJson).toMatchObject({ status: 'PROVISIONED', alreadyRegistered: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoAccountNumbers(bodyJson);
    });
  });

  describe('Increase transient failure', () => {
    it('keeps the signup successful with PENDING when Increase is unreachable', async () => {
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([new Error('connect ECONNREFUSED increase.example')]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as { ok: boolean; status: string; reason?: string };
      expect(bodyJson).toMatchObject({ ok: true, status: 'PENDING', reason: 'INCREASE_UNAVAILABLE' });
      expectNoAccountNumbers(bodyJson);
    });

    it('keeps the signup successful with PENDING when Increase rejects the call', async () => {
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([new Response('{"error":"upstream down"}', { status: 500 })]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as { status: string; reason?: string };
      expect(bodyJson).toMatchObject({ status: 'PENDING', reason: 'INCREASE_UNAVAILABLE' });
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain('upstream down');
      expect(getRegistry()?.rights_holders).toHaveLength(1);
      expectNoAccountNumbers(bodyJson);
    });
  });

  describe('internal fault handling', () => {
    it('returns a sanitized 500 when registration fails, without leaking the error', async () => {
      const failingDb = {
        query: vi.fn(),
        transaction: vi.fn(async () => {
          throw new Error('boom secret storage detail');
        }),
      };
      mockGetDb.mockReturnValue(failingDb as never);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(500);
      const bodyJson = (await res.json()) as { ok: boolean; error: string };
      expect(bodyJson).toMatchObject({ ok: false, error: 'Signup registration failed.' });
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain('boom');
      expect(text).not.toContain('storage');
    });

    it('returns a sanitized 500 when the holder vanishes before provisioning', async () => {
      const { db } = fakeDb({ dropAppendedHolder: true });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      const res = await POST(signupRequest({ email: EMAIL }));
      expect(res.status).toBe(500);
      const bodyJson = (await res.json()) as { ok: boolean; error: string };
      expect(bodyJson).toMatchObject({ ok: false, error: 'Signup could not complete provisioning.' });
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain('HOLDER_NOT_FOUND');
    });
  });

  describe('schema hygiene', () => {
    it('issues no money-movement or banking-era schema queries', async () => {
      const { db, txQueries } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      await POST(signupRequest({ email: EMAIL }));
      const allSql = txQueries.map((q) => q.sql).join('\n');
      expect(allSql).not.toContain('universal_royalty_ledger');
      expect(allSql).not.toContain('FROM rights_holders');
      expect(allSql).not.toContain('disbursements');
      expect(allSql).not.toContain('gross_settled');
    });
  });
});
