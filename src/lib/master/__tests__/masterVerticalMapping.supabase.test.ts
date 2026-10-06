/**
 * Master vertical mapping — the Supabase-parity leg of the regression
 * (data audit P1 #1). The SAME per-medium scenario rows, served through
 * the PostgREST read path (listAssets → cbt_assets, listLedger →
 * universal_royalty_ledger), must place identically to the in-memory leg
 * (masterVerticalMapping.test.ts): the vertical mapping is store-
 * independent by construction, and this file pins the OTHER real store
 * path of the resolver's data seam.
 *
 * Store coverage note: listAssets/listLedger expose exactly two real
 * paths — this Supabase PostgREST read and the in-memory index. The
 * SQLite Don Store's universal_royalty_ledger surface is the
 * territory-settlement read seam (store.ts listTerritorySettlements),
 * which this derivation does not consume; a SQLite leg would apply only
 * if the master ledger's data source moved to the Don Store.
 *
 * This leg also pins the sdk.ts column mapping (audit #5): the DB row's
 * cvt_code and holder_uct (migration 0056) surface on the listed asset —
 * the audit statement then labels a CBT as CBT because the CVT handle is
 * genuinely present when mapped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The PostgREST fake — only the read surface the two list paths exercise:
// from(table).select('*').order(...) awaitable to { data, error: null }.
type DbRow = Record<string, unknown>;

function fakeSupabase(tables: Record<string, DbRow[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        upsert: () => builder,
        insert: () => builder,
        update: () => builder,
        eq: () => builder,
        single: () => builder,
        maybeSingle: () => builder,
        then: (
          onFulfilled?: (value: { data: DbRow[]; error: null }) => unknown,
        ) => Promise.resolve({ data: rows, error: null }).then(onFulfilled),
      };
      return builder;
    },
  };
}

const { assetDbRows, ledgerDbRows } = vi.hoisted(() => {
  const assetRows: DbRow[] = [
    {
      cbt_code: 'CBT-TRK-000000000001',
      cvt_code: null, // the column is nullable — an unmapped handle stays absent
      holder_uct: null,
      title: 'Midnight Clear',
      medium: 'MUSIC_TRACK',
      mapped_identifiers: {},
      rights_holders: [],
      created_timestamp: 1_760_000_000_000,
    },
    {
      cbt_code: 'CBT-TVE-000000000004',
      cvt_code: 'CVT-8H2K4L-2026', // genuinely mapped — the audit labels it CVT
      holder_uct: 'uct_holder_tv',
      title: 'Season Archive',
      medium: 'TV_EPISODE',
      mapped_identifiers: {},
      rights_holders: [],
      created_timestamp: 1_760_000_000_001,
    },
  ];
  const ledgerRows: DbRow[] = [
    {
      transaction_id: 'tx-1',
      cbt_code: 'CBT-TRK-000000000001',
      platform: 'Probe',
      gross_settled: 1_000_000,
      covenant_fee: 0,
      corner_dust_collected: 0,
      currency: 'USD',
      disbursements: [],
      created_at: '2026-10-06T00:00:00.000Z',
    },
    {
      transaction_id: 'tx-2',
      cbt_code: 'CBT-TVE-000000000004',
      platform: 'Probe',
      gross_settled: 750_000,
      covenant_fee: 0,
      corner_dust_collected: 0,
      currency: 'USD',
      disbursements: [],
      created_at: '2026-10-06T00:00:01.000Z',
    },
    {
      // The orphan row — no cbt_assets record; the CBT type segment places it.
      transaction_id: 'tx-3',
      cbt_code: 'CBT-EBK-000000000009',
      platform: 'Store',
      gross_settled: 45_000,
      covenant_fee: 0,
      corner_dust_collected: 0,
      currency: 'USD',
      disbursements: [],
      created_at: '2026-10-06T00:00:02.000Z',
    },
  ];
  return { assetDbRows: assetRows, ledgerDbRows: ledgerRows };
});

vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: () =>
    fakeSupabase({ cbt_assets: assetDbRows, universal_royalty_ledger: ledgerDbRows }),
}));

const SAVED_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  // Real mode: the demo door closed; the ONLY Supabase client is the fake
  // above (the mocked supabaseFromEnv ignores env entirely).
  for (const key of ['DON_DEV_SEED', 'VERCEL_ENV']) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
  delete globalThis.__covnantSdk; // rebuild the singleton on the mocked client
});

afterAll(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis.__covnantSdk;
  delete globalThis.__covnantAssetIndex;
  delete globalThis.__covnantLedgerIndex;
});

describe('resolveMasterLedger — the Supabase PostgREST leg', () => {
  it('surfaces the DB-only columns on the listed asset — cvt_code and holder_uct mapped', async () => {
    const { listAssets } = await import('@/lib/sdk');
    const assets = await listAssets();
    expect(assets).toHaveLength(2);

    const tv = assets.find((asset) => asset.cbtCode === 'CBT-TVE-000000000004');
    expect(tv?.cvtCode).toBe('CVT-8H2K4L-2026');
    expect(tv?.holderUct).toBe('uct_holder_tv');

    const track = assets.find((asset) => asset.cbtCode === 'CBT-TRK-000000000001');
    // The honest absences: an unmapped handle is undefined, an unmapped
    // holder UCT is null — never a placeholder string.
    expect(track?.cvtCode).toBeUndefined();
    expect(track?.holderUct).toBeNull();
  });

  it('places the same rows on the same tabs as the in-memory leg', async () => {
    const { resolveMasterLedger } = await import('@/lib/master/masterStore');
    const { demo, records } = await resolveMasterLedger();
    expect(demo).toBe(false);
    expect(records).toHaveLength(3); // two asset rows + the orphan

    const byTitle = new Map(records.map((record) => [record.assetTitle, record]));
    expect(byTitle.get('Midnight Clear')?.category).toBe('AUDIO_AND_RECORDED_SOUND');
    expect(byTitle.get('Midnight Clear')?.subcategory).toBe('Commercial Music Releases');
    expect(byTitle.get('Season Archive')?.category).toBe('FILM_AND_TELEVISION');
    expect(byTitle.get('Season Archive')?.subcategory).toBe('Broadcast TV');
    // The orphan row — placed by its own CBT type segment.
    expect(byTitle.get('CBT-EBK-000000000009')?.category).toBe('PUBLISHING_AND_LITERARY');
    expect(byTitle.get('CBT-EBK-000000000009')?.subcategory).toBe('e-Books');
  });

  it('conserves gross across the placements', async () => {
    const { resolveMasterLedger } = await import('@/lib/master/masterStore');
    const { records } = await resolveMasterLedger();
    const derivedTotal = records.reduce((sum, record) => sum + record.grossVolumeCents, 0);
    expect(derivedTotal).toBe(1_000_000 + 750_000 + 45_000);
  });
});
