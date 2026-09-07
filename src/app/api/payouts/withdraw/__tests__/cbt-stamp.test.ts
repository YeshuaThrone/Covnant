import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { POST } from '../route';
import { supabaseFromEnv } from '@/lib/supabase';
import { CBT_SETTLEMENT_CODE_PATTERN, generateCBTSettlementCode } from '@/lib/ledger/cbt-settlement';

/**
 * Generation 9 — CBT stamp evidence for the payouts/withdraw ledger insert
 * (POST /api/payouts/withdraw). The legacy DISBURSEMENT payload shape is
 * never reshaped: the primary attempt adds ONLY metadata.cbt, derived
 * deterministically from the row's own transaction_id, and a live table
 * without the additive metadata column (42703/PGRST204) retries the row
 * WITHOUT the stamp so the payout — the money already moved — is still
 * recorded. Harness mirrors route.test.ts (unmodified): fetch stubbed for
 * the two Plaid calls, supabaseFromEnv mocked with a capture fake.
 */

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const mockSupabaseFromEnv = vi.mocked(supabaseFromEnv);

function fakeDb(options: {
  holderRow?: unknown;
  assetRows?: unknown[];
  ledgerData?: unknown[];
  insertError?: { code?: string; message: string } | null;
  metadataColumnMissing?: boolean;
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
        // lands via insert — the fake serves both and fails the STAMPED
        // attempt only when metadataColumnMissing is set (the live-table
        // shape where the additive metadata column has not been added yet).
        return {
          select: () => Promise.resolve({ data: options.ledgerData ?? [], error: null }),
          insert: (payload: Record<string, unknown>) => {
            inserts.push(payload);
            const missingColumn = options.metadataColumnMissing === true && 'metadata' in payload;
            if (missingColumn) {
              return Promise.resolve({
                error: {
                  code: 'PGRST204',
                  message:
                    "Could not find the 'metadata' column of 'universal_royalty_ledger' in the schema cache",
                },
              });
            }
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

function stubFetch(responses: Response[]): void {
  let index = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(responses[Math.min(index++, responses.length - 1)])),
  );
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/payouts/withdraw', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const connectedHolder = {
  plaid_access_token: 'access-sandbox-token',
  plaid_account_id: 'acc_1',
  method: 'ACH',
};

const holderProfile: TaxProfile = {
  taxFormType: 'W9_US_PERSON',
  taxIdentifierEncrypted: 'test-identifier',
  usTaxResident: true,
  isBackupWithholdingRequired: false,
  isVerified: false,
};

/** Ledger gross of 2.00 for rh_1 → 24% tax 0.48 → available 1.52. */
const grossLedgerRows = [{ disbursements: [{ rightsHolderId: 'rh_1', grossShare: 2.0 }] }];

function happyDb(
  overrides: {
    taxProfile?: TaxProfile;
    insertError?: { code?: string; message: string } | null;
    metadataColumnMissing?: boolean;
  } = {},
) {
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
    metadataColumnMissing: overrides.metadataColumnMissing,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PLAID_CLIENT_ID', 'test-client-id');
  vi.stubEnv('PLAID_SECRET', 'test-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('G2 · the withdraw DISBURSEMENT insert carries the deterministic CBT stamp', () => {
  it('writes metadata.cbt = { settlementCode, derivedFrom: "reference_id" } derived from the row transaction_id', async () => {
    stubFetch([jsonResponse({ id: 'auth_1' }), jsonResponse({ transfer: { id: 'tr_1' } })]);
    const { db, inserts } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);

    const insert = inserts[0];
    const metadata = insert.metadata as { cbt?: { settlementCode?: string; derivedFrom?: string } };
    expect(metadata.cbt?.settlementCode).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    expect(metadata.cbt?.settlementCode).toBe(
      generateCBTSettlementCode(insert.transaction_id as string),
    );
    expect(metadata.cbt?.derivedFrom).toBe('reference_id');
  });

  it('is merge-only: the legacy DISBURSEMENT payload keys survive untouched beside the stamp', async () => {
    stubFetch([jsonResponse({ id: 'auth_1' }), jsonResponse({ transfer: { id: 'tr_1' } })]);
    const { db, inserts } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));

    const insert = inserts[0];
    // The exact legacy shape (route.test.ts's frozen assertions) is intact…
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
    // …and metadata.cbt is the only addition.
    const metadata = insert.metadata as Record<string, unknown>;
    expect(Object.keys(metadata)).toEqual(['cbt']);
  });
});

describe('G4 · money never blocks on the withdraw path', () => {
  it('retries the row WITHOUT the stamp when the metadata column is missing and still records the payout', async () => {
    stubFetch([jsonResponse({ id: 'auth_1' }), jsonResponse({ transfer: { id: 'tr_1' } })]);
    const { db, inserts } = happyDb({ metadataColumnMissing: true });
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.plaidTransferId).toBe('tr_1');
    expect(inserts).toHaveLength(2);
    expect(inserts[0].metadata).toBeDefined();
    // The fallback is the exact legacy row — no metadata key at all.
    expect(inserts[1]).not.toHaveProperty('metadata');
    expect(inserts[1].transaction_id).toBe(inserts[0].transaction_id);
  });

  it('still returns 502 on a generic ledger failure (payout not silently unrecorded)', async () => {
    stubFetch([jsonResponse({ id: 'auth_1' }), jsonResponse({ transfer: { id: 'tr_1' } })]);
    const { db, inserts } = happyDb({ insertError: { message: 'duplicate key' } });
    mockSupabaseFromEnv.mockReturnValue(db);

    const res = await POST(postRequest({ rightsHolderId: 'rh_1', amount: '100000000' }));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
    expect(inserts).toHaveLength(1);
  });
});

describe('replay/determinism · each row derives its code from its own transaction_id', () => {
  it('stamps two independent payouts with codes that each derive from their own row reference', async () => {
    stubFetch([
      jsonResponse({ id: 'auth_1' }),
      jsonResponse({ transfer: { id: 'tr_1' } }),
      jsonResponse({ id: 'auth_2' }),
      jsonResponse({ transfer: { id: 'tr_2' } }),
    ]);
    const { db, inserts } = happyDb();
    mockSupabaseFromEnv.mockReturnValue(db);

    await POST(postRequest({ rightsHolderId: 'rh_1', amount: '10000000' }));
    await POST(postRequest({ rightsHolderId: 'rh_1', amount: '10000000' }));

    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      const metadata = insert.metadata as { cbt: { settlementCode: string } };
      expect(metadata.cbt.settlementCode).toBe(
        generateCBTSettlementCode(insert.transaction_id as string),
      );
      expect(metadata.cbt.settlementCode).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    }
  });
});
