import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CovenantMasterSDK,
  CovenantGlobalSocialEngine,
  CovenantTaxEngine,
  type SelfServeRightsHolder,
  type CovenantBlockAsset,
  type GlobalMatchClaimPayload,
  type SettlementResult,
  type TaxProfile,
  type SettlementCurrency,
} from '@/engine/covenant-master-sdk';
import {
  listLedger,
  rememberSettlement,
  totalsFrom,
  holderStatsFrom,
} from '../store';
/**
 * Mocked Supabase client — captures ledger upserts and feeds scripted selects so
 * the store's DB mode is exercised without a live Supabase project. The engine
 * never sees these env vars inside the tests below (they are set only after the
 * engine settle completes), so all DB traffic here belongs to the store layer.
 */
const sb = vi.hoisted(() => ({
  upsertCalls: [] as { table: string; rows: Record<string, unknown>[]; opts: unknown }[],
  failNextUpsert: false,
  selectResponse: { data: [] as Record<string, unknown>[], error: null as unknown },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      upsert: async (rows: Record<string, unknown>[], opts: unknown) => {
        sb.upsertCalls.push({ table, rows, opts });
        return sb.failNextUpsert ? { error: { message: 'boom' } } : { error: null };
      },
      select: () => ({
        order: async () => sb.selectResponse,
      }),
    }),
  }),
}));


/**
 * PR 4 — settlement math, tax/verification integration, and the ledger store.
 *
 * All arithmetic below follows the vendored engine (covenant-master-sdk.ts):
 * BigInt scaling per CURRENCY_DECIMALS, 10% social-path fee vs 0% direct fee,
 * and corner dust folded into the reported platform fee.
 */

const FEE_10 = 10.0;

function makeHolder(
  id: string,
  name: string,
  role: SelfServeRightsHolder['role'],
  splitPercentage: number,
  tax: Partial<TaxProfile> = {}
): SelfServeRightsHolder {
  return {
    id,
    name,
    role,
    splitPercentage,
    taxProfile: {
      taxFormType: 'W9_US_PERSON',
      taxIdentifierEncrypted: 'test-encrypted',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
      ...tax,
    },
    payoutRouting: {
      accountHolderName: name,
      bankName: 'Test Bank',
      accountNumberOrIBAN: 'acct-0001',
      routingOrBIC: 'TESTUS33',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH',
      railType: 'ACH',
    },
    confirmedByArtist: true,
  };
}

function registerAsset(
  sdk: CovenantMasterSDK,
  cbtCode: string,
  holders: SelfServeRightsHolder[]
): CovenantBlockAsset {
  const asset: CovenantBlockAsset = {
    cbtCode,
    title: `Test Asset ${cbtCode}`,
    medium: 'MUSIC_TRACK',
    mappedIdentifiers: { isrc: 'US-S1M-24-00001' },
    rightsHolders: holders,
    createdTimestamp: 1_000,
  };
  sdk.registerInMemory(asset);
  return asset;
}

function settle(
  sdk: CovenantMasterSDK,
  cbtCode: string,
  grossAmount: number,
  overrides: Partial<{ transactionId: string; currency: string; territory: string }> = {}
): Promise<SettlementResult> {
  return sdk.processRoyaltySettlement({
    transactionId: overrides.transactionId ?? `TEST-${Math.random().toString(36).slice(2, 10)}`,
    cbtCode,
    grossAmount,
    currency: (overrides.currency ?? 'USD') as SettlementCurrency,
    sourcePlatform: 'DIRECT',
    territoryCountryCode: overrides.territory ?? 'US',
    timestamp: Date.now(),
  });
}

beforeEach(() => {
  delete (globalThis as { __covnantLedgerIndex?: unknown }).__covnantLedgerIndex;
});

describe('direct settlement math (0% direct-path fee via app SDK; 10% tested below)', () => {
  it('splits a USD settlement exactly and reports PASS with no corner dust', async () => {
    const sdk = new CovenantMasterSDK(0.0);
    const { cbtCode } = { cbtCode: 'CBT-TRK-TEST000001' };
    registerAsset(sdk, cbtCode, [
      makeHolder('h1', 'Alice', 'COMPOSER', 50),
      makeHolder('h2', 'Bob', 'LYRICIST', 50),
    ]);

    const result = await settle(sdk, cbtCode, 100);

    expect(result.reconciliationStatus).toBe('PASS');
    expect(result.totalSettled).toBe(100);
    expect(result.platformFeeDeducted).toBe(0);
    expect(result.cornerDustCollected).toBe(0);
    expect(result.disbursements).toHaveLength(2);
    for (const d of result.disbursements) {
      expect(d.grossShare).toBe(50);
      expect(d.withholdingTaxRateApplied).toBe(0);
      expect(d.withholdingTaxDeducted).toBe(0);
      expect(d.netShare).toBe(50);
      expect(d.taxFormRequired).toBe('NONE'); // per-event share below the 600 threshold
      expect(d.routing.railType).toBe('ACH');
    }
  });

  it('applies a 10% platform fee and folds corner dust into the reported fee', async () => {
    const sdk = new CovenantMasterSDK(FEE_10);
    const cbtCode = 'CBT-TRK-TEST000002';
    // 1/3-style splits cannot divide 90.0000 evenly at 4 decimals → corner dust.
    registerAsset(sdk, cbtCode, [
      makeHolder('h1', 'Alice', 'COMPOSER', 33.3334),
      makeHolder('h2', 'Bob', 'LYRICIST', 33.3333),
      makeHolder('h3', 'Cara', 'PRODUCER', 33.3333),
    ]);

    const result = await settle(sdk, cbtCode, 100);

    expect(result.reconciliationStatus).toBe('PASS');
    // Engine: fee(10) + Σsplits floored; dust = settleable − Σsplits, folded into the fee line.
    expect(result.cornerDustCollected).toBeGreaterThanOrEqual(0);
    expect(result.platformFeeDeducted).toBeCloseTo(10 + result.cornerDustCollected, 6);
    // Engine's own reconciliation invariant, re-checked in raw units.
    const scale = 10_000;
    const units =
      BigInt(Math.round(result.platformFeeDeducted * scale)) +
      result.disbursements.reduce(
        (acc, d) => acc + BigInt(Math.round(d.netShare * scale)),
        0n
      );
    expect(units).toBe(100n * BigInt(scale));
  });

  it('withholds 30% statutory tax from a verified foreign holder without treaty data', async () => {
    const sdk = new CovenantMasterSDK(FEE_10);
    const cbtCode = 'CBT-TRK-TEST000003';
    registerAsset(sdk, cbtCode, [
      makeHolder('h1', 'Dora', 'COMPOSER', 100, {
        taxFormType: 'W8BEN_FOREIGN_INDIVIDUAL',
        usTaxResident: false,
        treatyCountryCode: 'DE',
        // No treatyWithholdingRate → the engine requires BOTH fields for the override.
      }),
    ]);

    const result = await settle(sdk, cbtCode, 100);

    const d = result.disbursements[0];
    expect(d.grossShare).toBe(90); // 100 − 10% fee
    expect(d.withholdingTaxRateApplied).toBe(0.3);
    // KNOWN ENGINE QUIRK (vendored, do not fix here): the settlement line divides the
    // fractional rate by (100 × scale) again, so a 0.30 rate deducts rate/100 of the
    // share (0.27 on 90), not 30% (27). calculateEffectiveTaxRate and the settlement
    // arithmetic disagree by 100×; flag for a re-blessed engine amendment.
    expect(d.withholdingTaxDeducted).toBe(0.27);
    expect(d.netShare).toBe(89.73);
    expect(d.taxFormRequired).toBe('1042-S');
    expect(d.isTaxReportable).toBe(true);
  });

  it('marks 1099-MISC when the per-event share reaches 600 and 1099-NEC for non-royalty roles', async () => {
    // Documents the engine's known behavior: the 1099 threshold is evaluated on the
    // per-event share (the settlement call has no YTD accumulator).
    const sdk = new CovenantMasterSDK(FEE_10);
    const cbtCode = 'CBT-TRK-TEST000004';
    registerAsset(sdk, cbtCode, [
      makeHolder('h1', 'Alice', 'COMPOSER', 50),
      makeHolder('h2', 'Evan', 'PRODUCER', 50),
    ]);

    // 1400 gross → 10% fee → 1260 settleable → 630 per holder ≥ 600 (per-event quirk).
    const result = await settle(sdk, cbtCode, 1400);

    const byHolder = new Map(result.disbursements.map((d) => [d.rightsHolderId, d]));
    expect(byHolder.get('h1')?.taxFormRequired).toBe('1099-MISC'); // COMPOSER → MISC
    expect(byHolder.get('h2')?.taxFormRequired).toBe('1099-NEC'); // PRODUCER → NEC
    expect(byHolder.get('h1')?.isTaxReportable).toBe(true);
  });

  it('rejects settlement of an unregistered asset in memory mode', async () => {
    const sdk = new CovenantMasterSDK(0.0);
    await expect(settle(sdk, 'CBT-TRK-MISSING000', 100)).rejects.toThrow(
      /not found in engine memory and no DB client supplied/
    );
  });
});

describe('CovenantTaxEngine rate table', () => {
  const base: TaxProfile = {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'x',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: true,
  };

  it('verified US person without backup withholding pays 0%', () => {
    expect(CovenantTaxEngine.calculateEffectiveTaxRate(base, 'US')).toBe(0);
  });

  it('applies 24% backup withholding to flagged US profiles (verified or not)', () => {
    expect(
      CovenantTaxEngine.calculateEffectiveTaxRate(
        { ...base, isBackupWithholdingRequired: true },
        'US'
      )
    ).toBe(0.24);
    expect(
      CovenantTaxEngine.calculateEffectiveTaxRate({ ...base, isVerified: false }, 'US')
    ).toBe(0.24);
  });

  it('defaults unverified foreign profiles and treaty-less foreign profiles to 30%', () => {
    const foreign: TaxProfile = { ...base, usTaxResident: false, taxFormType: 'W8BEN_FOREIGN_INDIVIDUAL' };
    expect(CovenantTaxEngine.calculateEffectiveTaxRate({ ...foreign, isVerified: false }, 'US')).toBe(0.3);
    expect(CovenantTaxEngine.calculateEffectiveTaxRate(foreign, 'US')).toBe(0.3);
  });

  it('honors a treaty override only when country AND rate are both present', () => {
    const foreign: TaxProfile = { ...base, usTaxResident: false, taxFormType: 'W8BEN_E_FOREIGN_ENTITY' };
    expect(
      CovenantTaxEngine.calculateEffectiveTaxRate(
        { ...foreign, treatyCountryCode: 'DE' },
        'DE'
      )
    ).toBe(0.3);
    expect(
      CovenantTaxEngine.calculateEffectiveTaxRate(
        { ...foreign, treatyCountryCode: 'DE', treatyWithholdingRate: 0.15 },
        'DE'
      )
    ).toBe(0.15);
  });
});

describe('social claims settlement path (10% fee, no allowlist entry)', () => {
  it('settles a platform claim on the 10% path with the CLAIM- transaction id format', async () => {
    const sdk = new CovenantMasterSDK(FEE_10);
    const engine = new CovenantGlobalSocialEngine(sdk);
    const cbtCode = 'CBT-TRK-TEST000005';
    registerAsset(sdk, cbtCode, [
      makeHolder('h1', 'Alice', 'COMPOSER', 50),
      makeHolder('h2', 'Bob', 'LYRICIST', 50),
    ]);

    const claim: GlobalMatchClaimPayload = {
      platform: 'SPOTIFY',
      cbtCode,
      externalAssetId: 'spotify:track:1234',
      mediaContentId: 'vid-9',
      channelOrProfileId: 'channel-7',
      grossAdRevenueOrRoyalty: 200,
      currency: 'USD',
      territoryCountryCode: 'US',
      timestamp: 1_720_000_000_000,
    };

    const result = await engine.processGlobalClaimEvent(claim);

    expect(result.transactionId).toBe('CLAIM-SPOTIFY-vid-9-1720000000000');
    expect(result.reconciliationStatus).toBe('PASS');
    expect(result.totalSettled).toBe(200);
    expect(result.platformFeeDeducted).toBe(20); // 10% social-path fee
    expect(result.disbursements.map((d) => d.netShare)).toEqual([90, 90]);
  });
});

describe('royalty ledger store (memory mode)', () => {
  it('persists a settled result, maps engine columns, and is idempotent per transaction', async () => {
    const sdk = new CovenantMasterSDK(0.0);
    const cbtCode = 'CBT-TRK-TEST000006';
    registerAsset(sdk, cbtCode, [makeHolder('h1', 'Alice', 'COMPOSER', 100)]);
    const result = await settle(sdk, cbtCode, 100, { transactionId: 'TX-1' });

    await rememberSettlement(result, 'DIRECT');
    await rememberSettlement(result, 'DIRECT'); // same transaction_id → replaced, not duplicated

    const rows = await listLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transactionId: 'TX-1',
      cbtCode,
      platform: 'DIRECT',
      grossSettled: 100,
      covenantFee: 0,
      cornerDustCollected: 0,
      currency: 'USD',
    });
    expect(rows[0].disbursements[0].netShare).toBe(100);
    expect(rows[0].createdAt).toBeTruthy();
  });

  it('totals settlements across rows', async () => {
    const sdk = new CovenantMasterSDK(FEE_10);
    const cbtCode = 'CBT-TRK-TEST000007';
    registerAsset(sdk, cbtCode, [makeHolder('h1', 'Alice', 'COMPOSER', 100)]);

    await rememberSettlement(await settle(sdk, cbtCode, 100, { transactionId: 'TX-A' }), 'SPOTIFY');
    await rememberSettlement(await settle(sdk, cbtCode, 50, { transactionId: 'TX-B' }), 'TIKTOK');

    const totals = totalsFrom(await listLedger());
    expect(totals.count).toBe(2);
    expect(totals.gross).toBe(150);
    expect(totals.fees).toBe(15); // 10 + 5
  });

  it('aggregates per-holder YTD across settlements and currencies', async () => {
    const sdk = new CovenantMasterSDK(FEE_10);
    const cbtCode = 'CBT-TRK-TEST000008';
    registerAsset(sdk, cbtCode, [
      makeHolder('h1', 'Alice', 'COMPOSER', 50),
      makeHolder('h2', 'Bob', 'LYRICIST', 50),
    ]);

    await rememberSettlement(await settle(sdk, cbtCode, 100, { transactionId: 'TX-1' }), 'SPOTIFY');
    await rememberSettlement(
      await settle(sdk, cbtCode, 200, { transactionId: 'TX-2', currency: 'EUR' }),
      'SPOTIFY'
    );

    const stats = holderStatsFrom(await listLedger());
    const alice = stats.get('h1');
    expect(alice).toBeDefined();
    expect(alice!.settlementCount).toBe(2);
    expect(alice!.grossYtd).toEqual({ USD: 45, EUR: 90 });
    expect(alice!.netYtd).toEqual({ USD: 45, EUR: 90 });
    expect(alice!.withheldYtd).toEqual({ USD: 0, EUR: 0 });
    expect(alice!.latestTaxForm).toBe('NONE');
    expect(stats.get('h2')!.grossYtd).toEqual({ USD: 45, EUR: 90 });
  });
});

describe('supabase-backed ledger persistence (mocked client)', () => {
  function enableDbMode(): void {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://covnant-test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  }

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    sb.upsertCalls.length = 0;
    sb.failNextUpsert = false;
    sb.selectResponse = { data: [], error: null };
  });

  it('upserts engine columns with transaction_id conflict handling', async () => {
    const sdk = new CovenantMasterSDK();
    const cbtCode = 'CBT-TRK-TEST000009';
    registerAsset(sdk, cbtCode, [makeHolder('h1', 'Alice', 'COMPOSER', 100)]);
    // Engine settles while still in memory mode — env vars are set only afterwards,
    // so every captured upsert below belongs to the store layer.
    const result = await settle(sdk, cbtCode, 200);

    enableDbMode();
    await rememberSettlement(result, 'DIRECT');
    await rememberSettlement(result, 'DIRECT'); // same transaction → conflict-replace, never duplicate

    expect(sb.upsertCalls).toHaveLength(2);
    const call = sb.upsertCalls[0];
    expect(call.table).toBe('universal_royalty_ledger');
    expect(call.opts).toEqual({ onConflict: 'transaction_id' });
    const row = call.rows[0];
    expect(row.transaction_id).toBe(result.transactionId);
    expect(row.cbt_code).toBe(cbtCode);
    expect(row.platform).toBe('DIRECT');
    expect(row.gross_settled).toBe(result.totalSettled);
    expect(row.covenant_fee).toBe(result.platformFeeDeducted);
    expect(row.corner_dust_collected).toBe(result.cornerDustCollected);
    expect(row.currency).toBe('USD');
    expect(row.disbursements).toEqual(result.disbursements);
    expect(sb.upsertCalls[1].rows[0]).toEqual(row);

    // Back in memory mode the replacement (not duplication) is observable: one row.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ledger = await listLedger();
    expect(ledger.filter((r) => r.transactionId === result.transactionId)).toHaveLength(1);
  });

  it('maps snake_case DB rows back to ledger rows on read', async () => {
    enableDbMode();
    sb.selectResponse = {
      data: [
        {
          transaction_id: 'TEST-DB1',
          cbt_code: 'CBT-TRK-TEST000010',
          platform: 'SPOTIFY',
          gross_settled: 100,
          covenant_fee: 10,
          corner_dust_collected: 0,
          currency: 'USD',
          disbursements: [],
          created_at: '2026-09-02T00:00:00.000Z',
        },
      ],
      error: null,
    };

    expect(await listLedger()).toEqual([
      {
        transactionId: 'TEST-DB1',
        cbtCode: 'CBT-TRK-TEST000010',
        platform: 'SPOTIFY',
        grossSettled: 100,
        covenantFee: 10,
        cornerDustCollected: 0,
        currency: 'USD',
        disbursements: [],
        createdAt: '2026-09-02T00:00:00.000Z',
      },
    ]);
  });

  it('throws a ledger error when the Supabase upsert fails', async () => {
    const sdk = new CovenantMasterSDK();
    const cbtCode = 'CBT-TRK-TEST000011';
    registerAsset(sdk, cbtCode, [makeHolder('h1', 'Bob', 'PRODUCER', 100)]);
    const result = await settle(sdk, cbtCode, 50);

    enableDbMode();
    sb.failNextUpsert = true;
    await expect(rememberSettlement(result, 'DIRECT')).rejects.toThrow(/Ledger upsert failed/);
  });
});
