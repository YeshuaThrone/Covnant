import { describe, it, expect } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import {
  escrowBalanceForHolder,
  grossUnitsForHolder,
  previousPayoutUnitsFor,
  smallestUnitsToPlaidAmount,
  taxRateForProfile,
  withholdingUnitsOn,
} from '../balance';

/**
 * Shared escrow balance math — pure-function contract tests. Every case runs
 * on BigInt smallest units (1e-8 scale, the ledger's numeric(20,8) space).
 */

function profile(overrides: Partial<TaxProfile>): TaxProfile {
  return {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'test-identifier',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: false,
    ...overrides,
  };
}

/** Engine-shaped settlement entry (numeric grossShare, no `type` field). */
const settlement = (rightsHolderId: string, grossShare: number) => ({ rightsHolderId, grossShare });

/** Withdraw-route payout entry (type 'DISBURSEMENT', unit-string amounts). */
const payout = (rightsHolderId: string, payoutAmount: string) => ({
  type: 'DISBURSEMENT',
  rightsHolderId,
  payoutAmount,
  amountPaid: payoutAmount,
  taxWithheld: '0',
  timestamp: 0,
  remainingNetBalance: '0',
});

describe('taxRateForProfile (engine effective rate on US territory)', () => {
  it('uses 24% for an unverified US person', () => {
    expect(taxRateForProfile(profile({ usTaxResident: true, isVerified: false }))).toBe(0.24);
  });

  it('uses 30% for an unverified foreign person', () => {
    expect(taxRateForProfile(profile({ usTaxResident: false, isVerified: false }))).toBe(0.3);
  });

  it('withholds 0% for a verified US person without backup withholding', () => {
    expect(taxRateForProfile(profile({ usTaxResident: true, isVerified: true }))).toBe(0);
  });

  it('uses the treaty rate for a verified foreign person with a treaty', () => {
    expect(
      taxRateForProfile(
        profile({ usTaxResident: false, isVerified: true, treatyCountryCode: 'DE', treatyWithholdingRate: 0.15 }),
      ),
    ).toBe(0.15);
  });
});

describe('withholdingUnitsOn', () => {
  it('computes exact 24% withholding in BigInt (no float multiply)', () => {
    expect(withholdingUnitsOn(100_000_000n, 0.24)).toBe(24_000_000n);
  });

  it('floors sub-unit dust exactly (150.75 × 24% = 36.18; 0.125 × 24% = 0.03)', () => {
    expect(withholdingUnitsOn(15_075_000_000n, 0.24)).toBe(3_618_000_000n);
    expect(withholdingUnitsOn(12_500_000n, 0.24)).toBe(3_000_000n);
  });

  it('supports fractional rates like 7.5% via the rate decimal string', () => {
    expect(withholdingUnitsOn(100_000_000n, 0.075)).toBe(7_500_000n);
  });

  it('returns 0 for a zero rate or non-positive gross', () => {
    expect(withholdingUnitsOn(100_000_000n, 0)).toBe(0n);
    expect(withholdingUnitsOn(0n, 0.24)).toBe(0n);
  });

  it('rejects rates outside [0, 1]', () => {
    expect(() => withholdingUnitsOn(1n, 1.5)).toThrow(RangeError);
  });
});

describe('grossUnitsForHolder', () => {
  it('sums settlement grossShare entries for the holder and skips others', () => {
    const entries = [settlement('rh_1', 100.5), settlement('rh_2', 999.99), settlement('rh_1', 50.25)];
    expect(grossUnitsForHolder(entries, 'rh_1')).toBe(15_075_000_000n);
  });

  it('ignores payout entries (they are debits, not earnings)', () => {
    const entries = [settlement('rh_1', 100), payout('rh_1', '1000000000')];
    expect(grossUnitsForHolder(entries, 'rh_1')).toBe(10_000_000_000n);
  });
});

describe('previousPayoutUnitsFor', () => {
  it('sums type-DISBURSEMENT payoutAmount entries for the holder only', () => {
    const entries = [payout('rh_1', '1000000000'), payout('rh_2', '500000000'), settlement('rh_1', 10)];
    expect(previousPayoutUnitsFor(entries, 'rh_1')).toBe(1_000_000_000n);
  });

  it('returns 0 when the holder has no payout entries', () => {
    expect(previousPayoutUnitsFor([settlement('rh_1', 10)], 'rh_1')).toBe(0n);
  });
});

describe('escrowBalanceForHolder', () => {
  const ledgerRows = [
    [settlement('rh_1', 100.5), settlement('rh_2', 700), payout('rh_1', '1000000000')],
    [settlement('rh_1', 50.25)],
  ];

  it('computes gross, 24% unverified-US tax, payouts, and net in smallest units', () => {
    const balance = escrowBalanceForHolder({
      disbursementsByRow: ledgerRows,
      rightsHolderId: 'rh_1',
      taxProfile: profile({ usTaxResident: true, isVerified: false }),
    });
    expect(balance.grossUnits).toBe(15_075_000_000n);
    expect(balance.taxRate).toBe(0.24);
    expect(balance.taxWithheldUnits).toBe(3_618_000_000n);
    expect(balance.previousPayoutUnits).toBe(1_000_000_000n);
    // 150.75 − 36.18 − 10.00 = 104.57
    expect(balance.availableUnits).toBe(10_457_000_000n);
  });

  it('withholds 30% for an unverified foreign profile', () => {
    const balance = escrowBalanceForHolder({
      disbursementsByRow: [[settlement('rh_1', 100)]],
      rightsHolderId: 'rh_1',
      taxProfile: profile({ usTaxResident: false, isVerified: false }),
    });
    expect(balance.taxWithheldUnits).toBe(3_000_000_000n);
    expect(balance.availableUnits).toBe(7_000_000_000n);
  });

  it('withholds 0% for a verified profile', () => {
    const balance = escrowBalanceForHolder({
      disbursementsByRow: [[settlement('rh_1', 100)]],
      rightsHolderId: 'rh_1',
      taxProfile: profile({ usTaxResident: true, isVerified: true }),
    });
    expect(balance.taxWithheldUnits).toBe(0n);
    expect(balance.availableUnits).toBe(10_000_000_000n);
  });

  it('keeps the dashboard zeroed for a holder with no ledger rows', () => {
    const balance = escrowBalanceForHolder({
      disbursementsByRow: [],
      rightsHolderId: 'rh_new',
      taxProfile: profile({}),
    });
    expect(balance.grossUnits).toBe(0n);
    expect(balance.availableUnits).toBe(0n);
  });
});

describe('smallestUnitsToPlaidAmount', () => {
  it('converts the locked example 100000000 → "1.00"', () => {
    expect(smallestUnitsToPlaidAmount(100_000_000n)).toBe('1.00');
  });

  it('formats whole and fractional dollar amounts', () => {
    expect(smallestUnitsToPlaidAmount(150_000_000n)).toBe('1.50');
    expect(smallestUnitsToPlaidAmount(0n)).toBe('0.00');
    expect(smallestUnitsToPlaidAmount(1n)).toBe('0.00');
  });

  it('truncates sub-cent dust rather than rounding up', () => {
    expect(smallestUnitsToPlaidAmount(123_456_789n)).toBe('1.23');
    expect(smallestUnitsToPlaidAmount(999_999_999n)).toBe('9.99');
  });

  it('handles very large balances without float loss', () => {
    expect(smallestUnitsToPlaidAmount(1_000_000_000_000_000_000n)).toBe('10000000000.00');
  });

  it('rejects negative units', () => {
    expect(() => smallestUnitsToPlaidAmount(-1n)).toThrow(RangeError);
  });
});
