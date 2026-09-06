import { describe, it, expect } from 'vitest';
import {
  CovenantMasterSDK,
  CovenantTaxEngine,
  type CovenantBlockAsset,
  type SelfServeRightsHolder,
} from '../covenant-master-sdk';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * The engine is vendored byte-for-byte from the source of truth
 * (fl_w9Jsv85C · gemini-code-1787976937198_2.ts · 686 lines). This test is the
 * tripwire: if anyone edits the vendored file, CI fails until the change is
 * either reverted or re-blessed through a spec amendment.
 */
const VENDORED_SHA256 = 'b60ec9de98e5890305b60cfe7cba93c016a2acc0b7a05c8d140c07c21f38dcc5';

describe('vendored engine integrity', () => {
  it('matches the blessed source-of-truth hash', () => {
    const filePath = path.join(__dirname, '..', 'covenant-master-sdk.ts');
    const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    expect(hash).toBe(VENDORED_SHA256);
  });
});

describe('CovenantMasterSDK (vendored, unmodified)', () => {
  const sdk = new CovenantMasterSDK(0.0);

  it('generates CBT codes in CBT-<MED>-<HASH> format', () => {
    const code = sdk.generateCBTCode('MUSIC_TRACK', 'Test Song');
    expect(code).toMatch(/^CBT-TRK-[0-9A-F]{12}$/);
  });

  it('round-trips assets through the in-memory registry', () => {
    const asset: CovenantBlockAsset = {
      cbtCode: 'CBT-TRK-000000000001',
      title: 'Roundtrip',
      medium: 'MUSIC_TRACK',
      mappedIdentifiers: { isrc: 'US-S1M-24-00001' },
      rightsHolders: [],
      createdTimestamp: 1_000,
    };
    sdk.registerInMemory(asset);
    expect(sdk.getInMemoryAsset('CBT-TRK-000000000001')?.title).toBe('Roundtrip');
  });

  it('rejects split sets that do not total exactly 100%', () => {
    const holder = (pct: number): SelfServeRightsHolder =>
      ({
        id: 'h1',
        name: 'H',
        role: 'COMPOSER',
        splitPercentage: pct,
        taxProfile: {
          taxFormType: 'W9_US_PERSON',
          taxIdentifierEncrypted: 'x',
          usTaxResident: true,
          isBackupWithholdingRequired: false,
          isVerified: true,
        },
        payoutRouting: {
          accountHolderName: 'H',
          bankName: 'B',
          accountNumberOrIBAN: '1',
          routingOrBIC: '2',
          currency: 'USD',
          countryCode: 'US',
          planetaryJurisdiction: 'EARTH',
          railType: 'ACH',
        },
        confirmedByArtist: true,
      }) as SelfServeRightsHolder;

    expect(() => sdk.validateSplits([holder(60), holder(30)])).toThrowError(/exactly 100/);
    expect(() => sdk.validateSplits([holder(60), holder(40)])).not.toThrow();
  });
});

describe('CovenantTaxEngine (vendored, unmodified)', () => {
  it('applies 24% US backup withholding and 30% foreign statutory rate', () => {
    const base = {
      taxFormType: 'W9_US_PERSON',
      taxIdentifierEncrypted: 'x',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    } as const;

    expect(CovenantTaxEngine.calculateEffectiveTaxRate({ ...base }, 'US')).toBe(0);
    expect(
      CovenantTaxEngine.calculateEffectiveTaxRate({ ...base, isBackupWithholdingRequired: true }, 'US')
    ).toBe(0.24);
    expect(
      CovenantTaxEngine.calculateEffectiveTaxRate(
        {
          ...base,
          usTaxResident: false,
          isVerified: true,
          taxFormType: 'W8BEN_FOREIGN_INDIVIDUAL',
        },
        'DE'
      )
    ).toBe(0.3);
  });
});
