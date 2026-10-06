
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { POST } from '../route';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { supabaseFromEnv } from '@/lib/supabase';
import { fakeEscrowDb, type FakeEscrowDb } from './fakeEscrowDb';

/**
 * POST /api/payouts/withdraw contract tests. Mocks only — no network, no
 * database. fetch is stubbed for the two Plaid calls; supabaseFromEnv is
 * mocked with the shared stateful escrow fake (fakeEscrowDb.ts), which
 * models migration 0058's reserve RPC, pending-intent reads, and settle/
 * release flips over one shared pool of funds.
 */

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

// Hardening (gen 12): the suite exercises the WITHDRAWAL flow as an
// authorized OPERATOR — the gate's 401/403 refusals are pinned in
// src/lib/server/__tests__/authz-gates.test.ts.
vi.mock('@/lib/server/apiAccess', () => ({
  requireHolderAccess: async (
    _request: unknown,
    requested: string | null | undefined,
  ) => ({
    ok: true as const,
    role: 'operator' as const,
    holderId:
      typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : null,
  }),
}));

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/payouts/withdraw', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

function happyDb(
  overrides: {
    taxProfile?: TaxProfile;
    insertError?: { message: string } | null;
    ledgerData?: unknown[];
  } = {},
): FakeEscrowDb {
  return fakeEscrowDb({
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
    ledgerData: overrides.ledgerData ?? [...grossLedgerRows],
    taxProfile: overrides.taxProfile ?? holderProfile,
    rightsHolderId: 'rh_1',
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
  // The route's shared limiter (5/min) is module state; every test starts
  // with a fresh window.
  resetRateLimits();
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
    for (const [i, amount] of [1_000_000_00, 'abc', '0', '-100000000', '1e9', undefined].entries()) {
      // Each attempt is its own client: a unique address per iteration keeps
      // the route's 5/min limiter from gating the validation battery.
      const res = await POST(
        postRequest({ rightsHolderId: 'rh_1', amount }, { 'x-forwarded-for': `198.51.100.${i}` }),
      );
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
    const { db } = fakeEscrowDb({
      holderRow: null,
      assetRows: [[{ id: 'rh_1', taxProfile: holderProfile }]],
      ledgerData: grossLedgerRows,
      taxProfile: holderProfile,
      rightsHolderId: 'rh_1',
    });
    mockSupabaseFromEnv.mockReturnValue(db);
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(409);
  });

  it('returns 409 when the rights_holders row lacks the Plaid token or account id', async () => {
    const { db } = fakeEscrowDb({
      holderRow: { plaid_access_token: null, plaid_account_id: 'acc_1' },
      assetRows: [[{ id: 'rh_1', taxProfile: holderProfile }]],
      ledgerData: grossLedgerRows,
      taxProfile: holderProfile,
      rightsHolderId: 'rh_1',
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

  it('counts a PENDING withdrawal hold against the balance the pre-check sees', async () => {
    // A stuck hold of 0.60 from an earlier attempt: the shared balance math
    // (dashboard and withdraw agree) must see available 0.92, so a 1.00
    // request is refused BEFORE anything dispatches.
    const { db } = fakeEscrowDb({
      holderRow: connectedHolder,
      assetRows: [[{ id: 'rh_1', name: 'Test Holder', role: 'COMPOSER', taxProfile: holderProfile }]],
      ledgerData: grossLedgerRows,
      taxProfile: holderProfile,
      rightsHolderId: 'rh_1',
      seedIntents: [{ id: 'intent_stuck', amount_units: '60000000' }],
    });
    mockSupabaseFromEnv.mockReturnValue(db);
    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(422);
  });

  it('authorizes and creates the Plaid transfer, inserts the DISBURSEMENT ledger row, and returns the exact payload', async () => {
    const fetchMock = stubFetch([
      jsonResponse({ id: 'auth_1', decision: 'approved' }),
      jsonResponse({ transfer: { id: 'tr_1' } }),
    ]);
    const { db, inserts, intents } = happyDb();
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

    // The intent-first lifecycle ran: one hold, settled once the row landed.
    expect(intents).toHaveLength(1);
    expect(intents[0].status).toBe('settled');
    expect(intents[0].plaid_transfer_id).toBe('tr_1');
    expect(intents[0].settled_at).toEqual(expect.any(String));

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

  it('propagates an authorization failure as a sanitized 502, records nothing, and RELEASES the hold', async () => {
    const fetchMock = stubFetch([jsonResponse({ error: 'insufficient_funds' }, 400)]);
    const { db, inserts, intents } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('insufficient_funds');
    expect(inserts).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The compensating release ran: the hold was taken (intent-first) and
    // then flipped to released — the funds are spendable again.
    expect(intents).toHaveLength(1);
    expect(intents[0].status).toBe('released');
    expect(intents[0].released_at).toEqual(expect.any(String));
  });

  it('releases the hold when the fetch rejects at the authorize stage (no transfer exists)', async () => {
    const fetchMock = vi.fn<() => Promise<Response>>().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const { db, intents } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
    expect(intents).toHaveLength(1);
    expect(intents[0].status).toBe('released');
  });

  it('KEEPS the hold pending when the fetch rejects at the create stage (outcome unknown — reconciliation decides)', async () => {
    const fetchMock = vi.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ id: 'auth_1' })) // authorize ok
      .mockRejectedValueOnce(new TypeError('fetch failed')); // create: network drop
    vi.stubGlobal('fetch', fetchMock);
    const { db, inserts, intents } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
    expect(inserts).toHaveLength(0);
    // Funds that may have moved are never released back by guesswork.
    expect(intents).toHaveLength(1);
    expect(intents[0].status).toBe('pending');
  });

  it('leaves the hold PENDING when the ledger insert fails — the retry is blocked until reconciliation settles it', async () => {
    stubFetch([jsonResponse({ id: 'auth_1' }), jsonResponse({ transfer: { id: 'tr_1' } })]);
    // Per-test ledger copy: reconciliation pushes the restored DISBURSEMENT
    // row into it later in the test.
    const ledgerData: { disbursements: unknown[] }[] = [
      { disbursements: [{ rightsHolderId: 'rh_1', grossShare: 2.0 }] },
    ];
    const fake = happyDb({ insertError: { message: 'duplicate key' }, ledgerData });
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    // First attempt: the transfer moves, the DISBURSEMENT insert fails → 502,
    // and the intent-first hold STAYS PENDING — closing the repeat-withdrawal
    // window (audit #5).
    const first = await POST(
      postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }, { 'x-forwarded-for': '198.51.100.20' }),
    );
    expect(first.status).toBe(502);
    expect((await first.json()).ok).toBe(false);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.intents).toHaveLength(1);
    expect(fake.intents[0].status).toBe('pending');

    // The immediate retry of the SAME funds: refused by the pending hold —
    // even though the ledger never recorded the payout.
    const retry = await POST(
      postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }, { 'x-forwarded-for': '198.51.100.21' }),
    );
    expect(retry.status).toBe(422);
    expect(fake.inserts).toHaveLength(1); // no second ledger row

    // Reconciliation: restore the DISBURSEMENT row (deterministic
    // ESCROW-PAYOUT-<intentId> id, UNIQUE(transaction_id)-idempotent) and
    // settle the hold. The fake models the post-restoration state.
    ledgerData.push({
      disbursements: [
        {
          type: 'DISBURSEMENT',
          rightsHolderId: 'rh_1',
          payoutAmount: '100000000',
          amountPaid: '76000000',
          taxWithheld: '24000000',
          timestamp: Date.now(),
          remainingNetBalance: '52000000',
        },
      ],
    });
    fake.forceSettle(fake.intents[0].id, 'tr_1');
    fake.setInsertError(null); // the reconciliation leg also cleared the fault
    stubFetch([jsonResponse({ id: 'auth_2' }), jsonResponse({ transfer: { id: 'tr_2' } })]);

    // Now the holder's remaining 0.52 is withdrawable again — and only 0.52.
    const after = await POST(
      postRequest({ rightsHolderId: 'rh_1', amount: '52000000' }, { 'x-forwarded-for': '198.51.100.22' }),
    );
    expect(after.status, JSON.stringify(await after.clone().json())).toBe(200);
    const overAfter = await POST(
      postRequest({ rightsHolderId: 'rh_1', amount: '52000000' }, { 'x-forwarded-for': '198.51.100.23' }),
    );
    expect(overAfter.status).toBe(422);
  });

  it('admits exactly ONE of N concurrent withdrawals of the same funds (audit #4)', async () => {
    // The fake's reserve RPC serializes on the shared pending state — the
    // observable behavior of migration 0058's per-holder advisory lock. Base
    // pool 1.52; all six requests ask for 1.00.
    let plaidCall = 0;
    const fetchMock = vi.fn<() => Promise<Response>>(() => {
      plaidCall += 1;
      return Promise.resolve(
        plaidCall % 2 === 1
          ? jsonResponse({ id: 'auth_c' })
          : jsonResponse({ transfer: { id: 'tr_c' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = happyDb();
    mockSupabaseFromEnv.mockReturnValue(fake.db);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        POST(
          postRequest(
            { rightsHolderId: 'rh_1', amount: '100000000' },
            // Unique addresses: the shared 5/min limiter must not gate the race.
            { 'x-forwarded-for': `198.51.101.${i + 10}` },
          ),
        ),
      ),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 422, 422, 422, 422, 422]);
    // Only the winner reached the rail — one authorize + one create.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Exactly one ledger row; exactly one intent, and it settled.
    expect(fake.inserts).toHaveLength(1);
    expect(fake.intents).toHaveLength(1);
    expect(fake.intents[0].status).toBe('settled');
  });
});
