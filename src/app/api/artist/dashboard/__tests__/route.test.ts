import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { GET } from '../route';
import { supabaseFromEnv } from '@/lib/supabase';

/**
 * GET /api/artist/dashboard contract tests. Mocks only — no network, no
 * database. The fake Supabase client serves canned cbt_assets rows and
 * universal_royalty_ledger disbursements; money assertions pin the exact
 * BigInt-smallest-unit strings the shared balance helper produces.
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

const rh1Holder = {
  id: 'rh_1',
  name: 'Test Holder',
  role: 'COMPOSER',
  splitPercentage: 1_000_000,
  taxProfile: unverifiedUsProfile(),
  payoutRouting: {},
  confirmedByArtist: true,
};

const assetRows = [
  {
    cvt_code: 'CVT-TEST-0001',
    cbt_code: 'CBT-001',
    title: 'Song One',
    medium: 'MUSIC',
    rights_holders: [rh1Holder, { id: 'rh_2', name: 'Other', role: 'LYRICIST' }],
  },
  {
    cvt_code: null, // legacy row registered before dual-code persistence
    cbt_code: 'CBT-002',
    title: 'Legacy Film',
    medium: 'FILM',
    rights_holders: [rh1Holder],
  },
  {
    cvt_code: 'CVT-TEST-0003',
    cbt_code: 'CBT-003',
    title: 'Unrelated Asset',
    medium: 'PODCAST',
    rights_holders: [{ id: 'rh_2', name: 'Other', role: 'HOST' }],
  },
];

const ledgerRows = [
  {
    disbursements: [
      { rightsHolderId: 'rh_1', grossShare: 100.5 }, // engine settlement entry
      { rightsHolderId: 'rh_2', grossShare: 700 },
    ],
  },
  {
    disbursements: [
      {
        type: 'DISBURSEMENT',
        rightsHolderId: 'rh_1',
        payoutAmount: '1000000000',
        amountPaid: '1000000000',
        taxWithheld: '0',
        timestamp: 0,
        remainingNetBalance: '0',
      },
      { rightsHolderId: 'rh_1', grossShare: 50.25 },
    ],
  },
];

type TableResult = { data: unknown[] | null; error: { message: string } | null };

function fakeDb(tables: Record<string, TableResult>): ReturnType<typeof supabaseFromEnv> {
  return {
    from: (table: string) => ({
      select: () => Promise.resolve(tables[table] ?? { data: [], error: null }),
    }),
  } as never;
}

beforeEach(() => {
  mockSupabaseFromEnv.mockReturnValue(
    fakeDb({
      cbt_assets: { data: assetRows, error: null },
      universal_royalty_ledger: { data: ledgerRows, error: null },
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/artist/dashboard', () => {
  it('returns 400 when rightsHolderId is missing', async () => {
    const res = await GET(new Request('http://localhost/api/artist/dashboard'));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('returns 503 when Supabase is unconfigured', async () => {
    mockSupabaseFromEnv.mockReturnValue(undefined);
    const res = await GET(new Request('http://localhost/api/artist/dashboard?rightsHolderId=rh_1'));
    expect(res.status).toBe(503);
  });

  it('returns a sanitized 502 when the asset read fails', async () => {
    mockSupabaseFromEnv.mockReturnValue(
      fakeDb({ cbt_assets: { data: null, error: { message: 'schema cache exploded' } } }),
    );
    const res = await GET(new Request('http://localhost/api/artist/dashboard?rightsHolderId=rh_1'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain('schema cache');
  });

  it('returns a sanitized 502 when the ledger balance read fails (fail closed)', async () => {
    mockSupabaseFromEnv.mockReturnValue(
      fakeDb({
        cbt_assets: { data: assetRows, error: null },
        universal_royalty_ledger: { data: null, error: { message: 'connection reset' } },
      }),
    );
    const res = await GET(new Request('http://localhost/api/artist/dashboard?rightsHolderId=rh_1'));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });

  it('returns the exact locked payload with BigInt-smallest-unit money strings', async () => {
    const res = await GET(new Request('http://localhost/api/artist/dashboard?rightsHolderId=rh_1'));
    expect(res.status).toBe(200);

    const body = await res.json();
    // Exact key set — no extra fields, nothing missing.
    expect(Object.keys(body).sort()).toEqual([
      'assets',
      'availableEscrowBalance',
      'grossEarnings',
      'isTaxVerified',
      'rightsHolderId',
      'taxWithheld',
    ]);
    expect(body.rightsHolderId).toBe('rh_1');
    // gross 150.75 → 15075000000; 24% unverified-US → 3618000000;
    // payouts 10.00 → available 104.57 → 10457000000.
    expect(body.grossEarnings).toBe('15075000000');
    expect(body.taxWithheld).toBe('3618000000');
    expect(body.availableEscrowBalance).toBe('10457000000');
    expect(body.isTaxVerified).toBe(false);
    expect(body.assets).toEqual([
      { cvtCode: 'CVT-TEST-0001', cbtCode: 'CBT-001', title: 'Song One', medium: 'MUSIC' },
      { cvtCode: null, cbtCode: 'CBT-002', title: 'Legacy Film', medium: 'FILM' },
    ]);
  });

  it('reports zero withholding for a verified holder and no assets for an unknown holder', async () => {
    const verifiedHolder = {
      ...rh1Holder,
      taxProfile: { ...unverifiedUsProfile(), isVerified: true },
    };
    mockSupabaseFromEnv.mockReturnValue(
      fakeDb({
        cbt_assets: { data: [{ ...assetRows[0], rights_holders: [verifiedHolder] }], error: null },
        universal_royalty_ledger: {
          data: [{ disbursements: [{ rightsHolderId: 'rh_1', grossShare: 100 }] }],
          error: null,
        },
      }),
    );

    const res = await GET(new Request('http://localhost/api/artist/dashboard?rightsHolderId=rh_1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isTaxVerified).toBe(true);
    expect(body.taxWithheld).toBe('0');
    expect(body.availableEscrowBalance).toBe('10000000000');

    const unknown = await GET(new Request('http://localhost/api/artist/dashboard?rightsHolderId=rh_missing'));
    expect(unknown.status).toBe(200);
    const unknownBody = await unknown.json();
    expect(unknownBody.grossEarnings).toBe('0');
    expect(unknownBody.isTaxVerified).toBe(false);
    expect(unknownBody.assets).toEqual([]);
  });
});
