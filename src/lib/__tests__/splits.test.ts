import { describe, expect, it } from 'vitest';
import type { SelfServeRightsHolder } from '@/engine/covenant-master-sdk';
import { CovenantMasterSDK } from '@/engine/covenant-master-sdk';
import { cvtDisplayCode } from '../splits/codes';
import {
  buildPoolWeightedSheet,
  holdersFromDrafts,
  poolWeightUnits,
  poolsFromSheet,
  registerMultiPoolAsset,
  saveAssetSplits,
  validateMultiPoolSplits,
} from '../splits/multi-pool';
import {
  describePoolGap,
  poolStateForUnits,
  POOL_NAMES,
  SPLIT_SCALE,
  sumPoolUnits,
  TARGET_UNITS,
} from '../splits/shared';

function makeHolder(id: string, splitPercentage: number, overrides: Partial<SelfServeRightsHolder> = {}): SelfServeRightsHolder {
  return {
    id,
    name: `Holder ${id}`,
    role: 'COMPOSER',
    splitPercentage,
    taxProfile: {
      taxFormType: 'W9_US_PERSON',
      taxIdentifierEncrypted: 'NOT_COLLECTED_V1',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    },
    payoutRouting: {
      accountHolderName: `Holder ${id}`,
      bankName: 'Test Bank',
      accountNumberOrIBAN: '000123456',
      routingOrBIC: '012345678',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH',
      railType: 'ACH',
    },
    confirmedByArtist: true,
    ...overrides,
  };
}

/** One holder per pool, each at 100% — the simplest exact three-pool asset. */
function exactPools(): { pool: 'MASTER_RECORDING' | 'WRITER_COMPOSITION' | 'PUBLISHER_ADMIN'; holders: SelfServeRightsHolder[] }[] {
  return [
    { pool: 'MASTER_RECORDING', holders: [makeHolder('h-master', 100)] },
    { pool: 'WRITER_COMPOSITION', holders: [makeHolder('h-writer', 100)] },
    { pool: 'PUBLISHER_ADMIN', holders: [makeHolder('h-pub', 100)] },
  ];
}

describe('multi-pool save gate', () => {
  it('rejects a pool at 99.9999%', () => {
    const sdk = new CovenantMasterSDK(0);
    const pools = [
      { pool: 'MASTER_RECORDING' as const, holders: [makeHolder('a', 100)] },
      { pool: 'WRITER_COMPOSITION' as const, holders: [makeHolder('b', 99.9999)] },
      { pool: 'PUBLISHER_ADMIN' as const, holders: [makeHolder('c', 100)] },
    ];
    const results = validateMultiPoolSplits(sdk, pools);
    expect(results.find((r) => r.pool === 'WRITER_COMPOSITION')).toMatchObject({ valid: false, sum: 99.9999 });
    expect(results.find((r) => r.pool === 'MASTER_RECORDING')?.valid).toBe(true);
    expect(poolStateForUnits(sumPoolUnits([99.9999]))).toBe('UNDER');
    expect(describePoolGap(sumPoolUnits([99.9999]))).toBe('needs 0.0001%');
  });

  it('rejects an over-allocated pool at 100.0001%', () => {
    const sdk = new CovenantMasterSDK(0);
    const results = validateMultiPoolSplits(sdk, [
      { pool: 'MASTER_RECORDING', holders: [makeHolder('a', 100.0001)] },
    ]);
    expect(results[0]).toMatchObject({ valid: false, sum: 100.0001 });
    expect(poolStateForUnits(sumPoolUnits([100.0001]))).toBe('OVER');
    expect(describePoolGap(sumPoolUnits([100.0001]))).toBe('+0.0001% over');
  });

  it('accepts three exact pools', () => {
    const sdk = new CovenantMasterSDK(0);
    const results = validateMultiPoolSplits(sdk, exactPools());
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.valid && r.sum === 100)).toBe(true);
  });

  it('one invalid pool blocks save and names the pool', async () => {
    const sdk = new CovenantMasterSDK(0);
    const pools = [
      { pool: 'MASTER_RECORDING' as const, holders: [makeHolder('a', 100)] },
      { pool: 'WRITER_COMPOSITION' as const, holders: [makeHolder('b', 100)] },
      { pool: 'PUBLISHER_ADMIN' as const, holders: [makeHolder('c', 99.9999), makeHolder('d', 0.0002)] },
    ];
    await expect(
      registerMultiPoolAsset(sdk, { title: 'Blocked Song', medium: 'MUSIC_TRACK', identifiers: {}, pools }),
    ).rejects.toThrow(/PUBLISHER_ADMIN at 100\.0001%/);
  });
});

describe('multi-pool registration', () => {
  it('registers through the engine and stores a pool-tagged sheet summing to exactly 10,000 units', async () => {
    const sdk = new CovenantMasterSDK(0);
    const { cbtCode } = await registerMultiPoolAsset(sdk, {
      title: 'Neon Covenant',
      medium: 'MUSIC_TRACK',
      identifiers: { isrc: 'US-XXX-26-00001' },
      pools: exactPools(),
    });
    expect(cbtCode).toMatch(/^CBT-TRK-[0-9A-F]{12}$/);

    const stored = sdk.getInMemoryAsset(cbtCode);
    expect(stored).toBeDefined();
    const units = sumPoolUnits(stored!.rightsHolders.map((h) => h.splitPercentage));
    expect(units).toBe(TARGET_UNITS);

    // The engine's own validation accepts the stored sheet.
    expect(() => sdk.validateSplits(stored!.rightsHolders)).not.toThrow();

    // Every holder carries a pool tag plus its true per-pool share.
    for (const holder of stored!.rightsHolders) {
      const tagged = holder as SelfServeRightsHolder & { pool?: string; poolSplitPercentage?: number };
      expect(POOL_NAMES).toContain(tagged.pool);
      expect(typeof tagged.poolSplitPercentage).toBe('number');
    }
    // True per-pool shares still sum to exactly 100.0000% per pool.
    for (const pool of POOL_NAMES) {
      const poolHolders = stored!.rightsHolders.filter(
        (h) => (h as SelfServeRightsHolder & { pool?: string }).pool === pool,
      );
      const trueUnits = sumPoolUnits(
        poolHolders.map((h) => (h as SelfServeRightsHolder & { poolSplitPercentage?: number }).poolSplitPercentage ?? 0),
      );
      expect(trueUnits).toBe(TARGET_UNITS);
    }
  });

  it('weights stored shares in equal thirds with integer-exact allocation', () => {
    expect(poolWeightUnits(3)).toEqual([333334, 333333, 333333]);
    const sheet = buildPoolWeightedSheet(exactPools());
    expect(sumPoolUnits(sheet.map((h) => h.splitPercentage))).toBe(TARGET_UNITS);
    expect(sheet.map((h) => h.splitPercentage)).toEqual([33.3334, 33.3333, 33.3333]);
  });

  it('assigns each pool residual unit to its largest holder deterministically', () => {
    const pools = [
      {
        pool: 'MASTER_RECORDING' as const,
        holders: [makeHolder('a', 33.3333), makeHolder('b', 33.3333), makeHolder('c', 33.3334)],
      },
      { pool: 'WRITER_COMPOSITION' as const, holders: [makeHolder('d', 100)] },
      { pool: 'PUBLISHER_ADMIN' as const, holders: [makeHolder('e', 100)] },
    ];
    const sheet = buildPoolWeightedSheet(pools);
    expect(sumPoolUnits(sheet.map((h) => h.splitPercentage))).toBe(TARGET_UNITS);
    // Pool 0 allocation is 333,334 units; 'c' holds the largest share and absorbs flooring residue.
    const stored = sheet
      .filter((h) => h.pool === 'MASTER_RECORDING')
      .map((h) => Math.round(h.splitPercentage * SPLIT_SCALE));
    expect(stored.reduce((a, b) => a + b, 0)).toBe(333334);
    const rawLargest = Math.round(33.3334 * SPLIT_SCALE);
    expect(stored[2]).toBe(Math.floor((rawLargest * 333334) / TARGET_UNITS) + 1);
  });
});

describe('multi-pool split sheet updates', () => {
  it('re-validates and refuses to write when a pool is off', async () => {
    const sdk = new CovenantMasterSDK(0);
    const { cbtCode } = await registerMultiPoolAsset(sdk, {
      title: 'Update Me',
      medium: 'MUSIC_TRACK',
      identifiers: {},
      pools: exactPools(),
    });
    const bad = [
      { pool: 'MASTER_RECORDING' as const, holders: [makeHolder('a', 60), makeHolder('a2', 40)] },
      { pool: 'WRITER_COMPOSITION' as const, holders: [makeHolder('b', 50)] },
      { pool: 'PUBLISHER_ADMIN' as const, holders: [makeHolder('c', 100)] },
    ];
    const results = await saveAssetSplits(sdk, cbtCode, bad);
    expect(results.some((r) => !r.valid)).toBe(true);
    // Nothing written: the stored sheet is unchanged.
    const stored = sdk.getInMemoryAsset(cbtCode)!;
    expect(stored.rightsHolders).toHaveLength(3);
  });

  it('writes an exact updated sheet and preserves true per-pool shares', async () => {
    const sdk = new CovenantMasterSDK(0);
    const { cbtCode } = await registerMultiPoolAsset(sdk, {
      title: 'Update Me',
      medium: 'MUSIC_TRACK',
      identifiers: {},
      pools: exactPools(),
    });
    const updated = [
      { pool: 'MASTER_RECORDING' as const, holders: [makeHolder('a', 60), makeHolder('a2', 40)] },
      { pool: 'WRITER_COMPOSITION' as const, holders: [makeHolder('b', 100)] },
      { pool: 'PUBLISHER_ADMIN' as const, holders: [makeHolder('c', 100)] },
    ];
    const results = await saveAssetSplits(sdk, cbtCode, updated);
    expect(results.every((r) => r.valid)).toBe(true);

    const stored = sdk.getInMemoryAsset(cbtCode)!;
    expect(sumPoolUnits(stored.rightsHolders.map((h) => h.splitPercentage))).toBe(TARGET_UNITS);
    const roundTrip = poolsFromSheet(stored);
    const master = roundTrip.find((p) => p.pool === 'MASTER_RECORDING')!;
    expect(master.holders.map((h) => h.splitPercentage)).toEqual([60, 40]);
    expect(sumPoolUnits(master.holders.map((h) => h.splitPercentage))).toBe(TARGET_UNITS);
  });
});

describe('studio draft mapping', () => {
  it('maps drafts to engine holders with full tax and routing profiles', () => {
    const holders = holdersFromDrafts([
      {
        id: 'h1',
        name: 'Ada Composer',
        role: 'COMPOSER',
        splitPercentage: 100,
        taxFormType: 'W8BEN_FOREIGN_INDIVIDUAL',
        usTaxResident: false,
        isVerified: false,
        routing: {
          accountHolderName: 'Ada Composer',
          bankName: 'Foreign Bank',
          accountNumberOrIBAN: 'GB29NWBK601613',
          routingOrBIC: 'NWBKGB2L',
          currency: 'GBP',
          countryCode: 'GB',
          planetaryJurisdiction: 'EARTH',
          railType: 'SWIFT',
        },
      },
    ]);
    expect(holders).toHaveLength(1);
    expect(holders[0].taxProfile.taxFormType).toBe('W8BEN_FOREIGN_INDIVIDUAL');
    expect(holders[0].taxProfile.isVerified).toBe(false);
    expect(holders[0].payoutRouting.railType).toBe('SWIFT');
    expect(holders[0].confirmedByArtist).toBe(true);
  });
});

describe('CVT display codes', () => {
  it('derives CVT-<PREFIX>-XXXX from the canonical CBT code', () => {
    expect(cvtDisplayCode('CBT-TRK-ABCDEF123456')).toBe('CVT-TRK-3456');
    expect(cvtDisplayCode('CBT-FILM-0000000000FF')).toBe('CVT-FILM-00FF');
  });

  it('passes malformed codes through uppercased', () => {
    expect(cvtDisplayCode('not-a-code')).toBe('NOT-A-CODE');
  });
});
