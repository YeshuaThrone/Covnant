
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { POST } from '../route';
import { supabaseFromEnv } from '@/lib/supabase';

/**
 * POST /api/payouts/withdraw contract tests. Mocks only — no network, no
 * database. fetch is stubbed for the two Plaid calls; supabaseFromEnv is
 * mocked with a fake client covering rights_holders reads, cbt_assets reads,
 * and the ledger insert payload capture.
 */

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const mockSupabaseFromEnv = vi.mocked(supabaseFromEnv);

function unverifiedUsProfile(): TaxProfile {
  return {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'test-identifier',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: false,
  };
}

function fakeDb(options: {
  holderRow?: unknown;
  assetRows?: unknown[];
  ledgerData?: unknown[];
  insertError?: { message: string } | null;
}) {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from: (table: string) => {
      if (table === 'rights_holders') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: options.holderRow ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === 'cbt_assets') {
        return {
          select: () =>
            Promise.resolve({
              data: (options.assetRows ?? []).map((rights_holders) => ({ rights_holders })),
              error: null,
            }),
        };
      }
      if (table === 'universal_royalty_ledger') {
        // fetchEscrowBalance reads this table via select; the payout write
        // lands via insert — the fake serves both.
        return {
          select: () => Promise.resolve({ data: options.ledgerData ?? [], error: null }),
          insert: (payload: Record<string, unknown>) => {
            inserts.push(payload);
            return Promise.resolve({ error: options.insertError ?? null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db: db as never, inserts };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/payouts/withdraw', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Holder row with a connected payout account. */
const connectedHolder = {
  plaid_access_token: 'access-sandbox-token',
  plaid_account_id: 'acc_1',
  method: 'ACH',
};

/** Holder profile on an asset, unverified US → 24% engine rate. */
const holderProfile = unverifiedUsProfile();

/** Ledger gross of 2.00 for rh_1 → 24% tax 0.48 → available 1.52. */
const grossLedgerRows = [{ disbursements: [{ rightsHolderId: 'rh_1', grossShare: 2.0 }] }];

function happyDb(overrides: { taxProfile?: TaxProfile; insertError?: { message: string } | null } = {}) {
  return fakeDb({
    holderRow: connectedHolder,
    assetRows: [
      [
        {
          id: 'rh_1',
          name: 'Test Holder',
          role: 'COMPOSER',
          taxProfile: overrides.taxProfile ?? holderProfile,
        },
      ],
    ],
    ledgerData: grossLedgerRows,
    insertError: overrides.insertError ?? null,
  });
}

function stubFetch(sequence: Response[]) {
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  for (const res of sequence) fetchMock.mockResolvedValueOnce(res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv('PLAID_CLIENT_ID', 'test-client-id');
  vi.stubEnv('PLAID_SECRET', 'test-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /api/payouts/withdraw', () => {
  it('returns 400 when rightsHolderId is missing', async () => {
    const res = await POST(postRequest({ amount: '100000000' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid amounts (non-string, non-numeric, zero, negative)', async () => {
    for (const amount of [1_000_000_00, 'abc', '0', '-100000000', '1e9', undefined]) {
      const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount }));
      expect(res.status).toBe(400);
    }
  });

  it('returns 400 for an invalid currency', async () => {
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000', currency: 'eu' }));
    expect(res.status).toBe(400);
  });

  it('returns 503 when Plaid credentials are absent', async () => {
    delete process.env.PLAID_CLIENT_ID;
    const { db } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(503);
  });

  it('returns 503 when Supabase is unconfigured', async () => {
    mockSupabaseFromEnv.mockReturnValue(undefined);
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(503);
  });

  it('returns 409 when the rights_holders row is missing', async () => {
    const { db } = fakeDb({
      holderRow: null,
      assetRows: [[{ id: 'rh_1', taxProfile: holderProfile }]],
      ledgerData: grossLedgerRows,
    });
    mockSupabaseFromEnv.mockReturnValue(db);
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(409);
  });

  it('returns 409 when the rights_holders row lacks the Plaid token or account id', async () => {
    const { db } = fakeDb({
      holderRow: { plaid_access_token: null, plaid_account_id: 'acc_1' },
      assetRows: [[{ id: 'rh_1', taxProfile: holderProfile }]],
      ledgerData: grossLedgerRows,
    });
    mockSupabaseFromEnv.mockReturnValue(db);
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(409);
  });

  it('returns 422 when the amount exceeds the available escrow balance', async () => {
    const { db } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);
    // available = 152000000 (1.52); request 2.00
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '200000000' }));
    expect(res.status).toBe(422);
  });

  it('authorizes and creates the Plaid transfer, inserts the DISBURSEMENT ledger row, and returns the exact payload', async () => {
    const fetchMock = stubFetch([
      jsonResponse({ id: 'auth_1', decision: 'approved' }),
      jsonResponse({ transfer: { id: 'tr_1' } }),
    ]);
    const { db, inserts } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(200);

    // Authorization call carries the stored account + the net amount (24% withheld).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [authCall, transferCall] = fetchMock.mock.calls;
    expect(String(authCall[0])).toBe('https://production.plaid.com/transfer/authorization/create');
    expect(JSON.parse(String((authCall[1] as RequestInit).body))).toEqual({
      client_id: 'test-client-id',
      secret: 'test-secret',
      access_token: 'access-sandbox-token',
      account_id: 'acc_1',
      amount: '0.76', // 1.00 net of 0.24 withholding
      network: 'ach',
      type: 'credit',
      ach_class: 'ppd',
      user: { legal_name: 'Test Holder' },
    });

    // Transfer call references the authorization id.
    expect(String(transferCall[0])).toBe('https://production.plaid.com/transfer/create');
    expect(JSON.parse(String((transferCall[1] as RequestInit).body))).toMatchObject({
      authorization_id: 'auth_1',
      amount: '0.76',
    });

    // Ledger insert: DISBURSEMENT sentinel row with the full audit entry.
    expect(inserts).toHaveLength(1);
    const insert = inserts[0];
    expect(insert.transaction_id).toEqual(expect.stringMatching(/^ESCROW-PAYOUT-/));
    expect(insert.transaction_type).toBe('DISBURSEMENT');
    expect(insert.cbt_code).toBe('ESCROW-PAYOUT');
    expect(insert.platform).toBe('PLAID');
    expect(insert.gross_settled).toBe('1.00000000');
    expect(insert.currency).toBe('USD');
    expect(insert.disbursements).toEqual([
      {
        type: 'DISBURSEMENT',
        rightsHolderId: 'rh_1',
        payoutAmount: '100000000',
        amountPaid: '76000000',
        taxWithheld: '24000000',
        plaidAuthorizationId: 'auth_1',
        plaidTransferId: 'tr_1',
        timestamp: expect.any(Number),
        remainingNetBalance: '52000000',
      },
    ]);

    // Exact response shape, money as smallest-unit strings.
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'ok',
      'payoutAmount',
      'plaidTransferId',
      'remainingNetBalance',
      'taxWithheld',
    ]);
    expect(body).toEqual({
      ok: true,
      plaidTransferId: 'tr_1',
      payoutAmount: '100000000',
      taxWithheld: '24000000',
      remainingNetBalance: '52000000',
    });
  });

  it('withholds nothing for a verified profile and converts the full amount at the Plaid boundary', async () => {
    stubFetch([jsonResponse({ id: 'auth_v' }), jsonResponse({ transfer: { id: 'tr_v' } })]);
    const { db } = happyDb({ taxProfile: { ...holderProfile, isVerified: true } });
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taxWithheld).toBe('0');
    expect(body.payoutAmount).toBe('100000000');
    // Verified profile → zero withholding → available 2.00 − 1.00 payout = 1.00 remaining.
    expect(body.remainingNetBalance).toBe('100000000');
  });

  it('propagates an authorization failure as a sanitized 502 and records nothing', async () => {
    const fetchMock = stubFetch([jsonResponse({ error: 'insufficient_funds' }, 400)]);
    const { db, inserts } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('insufficient_funds');
    expect(inserts).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a network-level fetch rejection as a sanitized 502', async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const { db } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });

  it('returns 502 when the ledger insert fails (payout not silently unrecorded)', async () => {
    stubFetch([jsonResponse({ id: 'auth_1' }), jsonResponse({ transfer: { id: 'tr_1' } })]);
    const { db } = happyDb({ insertError: { message: 'duplicate key' } });
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });
});
