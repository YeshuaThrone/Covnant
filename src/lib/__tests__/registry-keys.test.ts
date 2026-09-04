import { describe, it, expect } from 'vitest';
import type { CovenantMasterSDK, SelfServeRightsHolder } from '@/engine/covenant-master-sdk';
import {
  DUPLICATE_ASSET_MESSAGE,
  DuplicateAssetRegistrationError,
  isDuplicateKeyError,
  registerMultiPoolAsset,
  type SplitPool,
} from '@/lib/splits/multi-pool';
import {
  auditKeyHash,
  registryPillsForCode,
  resolveRegistryPills,
  sectorAuditKey,
  withRegistryPills,
} from '@/lib/assets/registry-keys';

describe('registry pill resolver (universal tracking keys)', () => {
  const CBT = 'CBT-TRK-000000000001';

  it('derives CBT + CVT audit pills from the canonical code alone', () => {
    const pills = registryPillsForCode(CBT);
    expect(pills.map((p) => p.key)).toEqual(['cbt', 'cvt']);
    expect(pills[0]).toMatchObject({ label: 'CBT', value: CBT, source: 'engine' });
    expect(pills[1]).toMatchObject({ label: 'CVT', value: 'CVT-TRK-0001', source: 'derived' });
  });

  it('provisions ISRC (Recording) + ISWC (Composition) for Music & Audio', () => {
    const pills = resolveRegistryPills({ cbtCode: CBT, medium: 'MUSIC_TRACK' });
    const labels = pills.map((p) => p.label);
    expect(labels).toContain('ISRC (Recording)');
    expect(labels).toContain('ISWC (Composition)');
    const isrc = pills.find((p) => p.label === 'ISRC (Recording)');
    const iswc = pills.find((p) => p.label === 'ISWC (Composition)');
    expect(isrc?.value).toMatch(/^CVT-ISRC-[0-9A-F]{4}$/);
    expect(iswc?.value).toMatch(/^CVT-ISWC-[0-9A-F]{4}$/);
    expect(pills.some((p) => p.label.startsWith('EIDR'))).toBe(false);
  });

  it('provisions EIDR (10.5240 Root Standard) for Film/TV/Video and nothing else', () => {
    for (const medium of ['FEATURE_FILM', 'TV_EPISODE', 'LIVE_STREAM'] as const) {
      const pills = resolveRegistryPills({ cbtCode: 'CBT-FLM-000000000002', medium });
      expect(pills.map((p) => p.label)).toContain('EIDR (10.5240 Root Standard)');
      expect(pills.some((p) => p.label.startsWith('ISRC'))).toBe(false);
      expect(pills.some((p) => p.label.startsWith('ISWC'))).toBe(false);
      const eidr = pills.find((p) => p.label.startsWith('EIDR'));
      expect(eidr?.value).toMatch(/^CVT-EIDR-[0-9A-F]{4}$/);
    }
  });

  it('gives print media only the CBT/CVT internal audit keys', () => {
    const pills = resolveRegistryPills({ cbtCode: CBT, medium: 'PRINT_BOOK' });
    expect(pills.map((p) => p.key)).toEqual(['cbt', 'cvt']);
  });

  it('is deterministic — the same asset resolves identical keys on every call', () => {
    const a = resolveRegistryPills({ cbtCode: CBT, medium: 'MUSIC_ALBUM' });
    const b = resolveRegistryPills({ cbtCode: CBT, medium: 'MUSIC_ALBUM' });
    expect(a).toEqual(b);
    expect(sectorAuditKey(CBT, { field: 'isrc', label: 'x', prefix: 'ISRC' })).toBe(
      sectorAuditKey(CBT, { field: 'isrc', label: 'x', prefix: 'ISRC' }),
    );
    expect(auditKeyHash('seed')).toMatch(/^[0-9A-F]{4}$/);
  });

  it('prefers engine-stored mapped identifiers and skips the derived key for that slot', () => {
    const pills = resolveRegistryPills({
      cbtCode: CBT,
      medium: 'MUSIC_TRACK',
      mappedIdentifiers: { isrc: 'US-S1M-26-00001' },
    });
    expect(pills.find((p) => p.key === 'mapped-isrc')).toMatchObject({
      label: 'ISRC',
      value: 'US-S1M-26-00001',
      source: 'engine',
    });
    expect(pills.some((p) => p.value.startsWith('CVT-ISRC-'))).toBe(false);
    // The engine does not supply ISWC — its derived audit key remains.
    expect(pills.some((p) => p.value.startsWith('CVT-ISWC-'))).toBe(true);
  });
});

describe('duplicate collision classification (adapter layer)', () => {
  it('flags the engine-wrapped Postgres unique-constraint failure', () => {
    expect(
      isDuplicateKeyError(
        new Error(
          'Database registration failed: duplicate key value violates unique constraint "cbt_assets_cbt_code_key"',
        ),
      ),
    ).toBe(true);
    expect(isDuplicateKeyError(new Error('Database registration failed: network error'))).toBe(
      false,
    );
    expect(isDuplicateKeyError(new Error('Total splits must equal exactly 100.0000%'))).toBe(false);
  });

  it('rejects an identical medium+title before any write via the catalog probe', async () => {
    let engineCalled = false;
    const sdk = {
      validateSplits: () => {},
      registerCBTAsset: async () => {
        engineCalled = true;
        return { cbtCode: 'CBT-TRK-FFFFFFFFFFFF', success: true };
      },
    } as unknown as CovenantMasterSDK;

    await expect(
      registerMultiPoolAsset(
        sdk,
        { title: 'Same Song', medium: 'MUSIC_TRACK', identifiers: {}, pools: singlePool() },
        { findExisting: (t, m) => Promise.resolve(t === 'Same Song' && m === 'MUSIC_TRACK') },
      ),
    ).rejects.toMatchObject({
      name: 'DuplicateAssetRegistrationError',
      message: DUPLICATE_ASSET_MESSAGE,
    });
    expect(engineCalled).toBe(false);
  });

  it('rethrows the raw DB duplicate-key error as the typed duplicate error', async () => {
    const sdk = {
      validateSplits: () => {},
      registerCBTAsset: async () => {
        throw new Error(
          'Database registration failed: duplicate key value violates unique constraint "cbt_assets_cbt_code_key"',
        );
      },
    } as unknown as CovenantMasterSDK;

    await expect(
      registerMultiPoolAsset(sdk, {
        title: 'Fresh Song',
        medium: 'MUSIC_TRACK',
        identifiers: {},
        pools: singlePool(),
      }),
    ).rejects.toBeInstanceOf(DuplicateAssetRegistrationError);
  });

  it('still registers normally when nothing collides', async () => {
    const sdk = {
      validateSplits: () => {},
      registerCBTAsset: async () => ({ cbtCode: 'CBT-TRK-AAAAAAAAAAAA', success: true }),
    } as unknown as CovenantMasterSDK;

    await expect(
      registerMultiPoolAsset(
        sdk,
        { title: 'Fresh Song', medium: 'MUSIC_TRACK', identifiers: {}, pools: singlePool() },
        { findExisting: () => Promise.resolve(false) },
      ),
    ).resolves.toEqual({ cbtCode: 'CBT-TRK-AAAAAAAAAAAA', success: true });
  });
});

describe('Black Box Shield payload attachment', () => {
  it('attaches registry pills to a ledger-bound payload next to the amounts', () => {
    const payload = { cbtCode: 'CBT-TRK-000000000009', grossSettled: 100 };
    const shielded = withRegistryPills(payload, {
      cbtCode: 'CBT-TRK-000000000009',
      medium: 'MUSIC_TRACK',
    });
    expect(shielded.grossSettled).toBe(100);
    expect(shielded.registry.map((p) => p.key)).toEqual([
      'cbt',
      'cvt',
      'derived-isrc',
      'derived-iswc',
    ]);
  });

  it('falls back to code-derived pills when the asset is not at hand', () => {
    const shielded = withRegistryPills({ cbtCode: 'CBT-FLM-00000000000A' });
    expect(shielded.registry.map((p) => p.key)).toEqual(['cbt', 'cvt']);
    expect(shielded.registry[1].value).toBe('CVT-FLM-000A');
  });
});

/** One holder at exactly 100% — satisfies the multi-pool save gate. */
function singlePool(): SplitPool[] {
  const holder: SelfServeRightsHolder = {
    id: 'h1',
    name: 'A',
    role: 'PRODUCER',
    splitPercentage: 100,
    taxProfile: {
      taxFormType: 'W9_US_PERSON',
      taxIdentifierEncrypted: 'x',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    },
    payoutRouting: {
      accountHolderName: 'A',
      bankName: 'B',
      accountNumberOrIBAN: '1',
      routingOrBIC: '2',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH',
      railType: 'ACH',
    },
    confirmedByArtist: true,
  };
  return [{ pool: 'MASTER_RECORDING', holders: [holder] }];
}
