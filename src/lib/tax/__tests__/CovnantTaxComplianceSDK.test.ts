/**
 * CovnantTaxEngineSDK — the founder engine of record, verbatim (founder
 * code drop, 2026-09-21). Every branch of processPayout is asserted against
 * the founder's own canon: the 24 percent US backup withholding, the treaty
 * royalty table (GB/DE/CA/JP/FR at 0.00, MX 0.10, AU 0.05, IN 0.15), the
 * 30 percent statutory fallback, the mandatory unverified-foreign lock, the
 * $10 MISC and $2,000 NEC form thresholds on cumulative YTD, state nexus
 * rates, and the integer-cent net. These tests are the engine's contract —
 * the Tax tab hydrates through this engine, so its branches are law.
 */
import { describe, expect, it } from 'vitest';

import { CovnantTaxEngineSDK, type PayeeTaxProfile } from '../CovnantTaxComplianceSDK';

const ENGINE = new CovnantTaxEngineSDK();

/** A US verified royalty payee with no YTD — the clean baseline. */
function profile(overrides: Partial<PayeeTaxProfile>): PayeeTaxProfile {
  return {
    payeeId: 'payee-test',
    payeeName: 'Test Payee',
    countryCode: 'US',
    tinStatus: 'VERIFIED',
    formType: '1099_MISC',
    usResident: true,
    treatyClaimActive: false,
    ytdClearedGrossUSD: 0,
    ...overrides,
  };
}

function resolve(overrides: {
  payee?: Partial<PayeeTaxProfile>;
  grossAmountUSD?: number;
  payoutType?: 'ROYALTY' | 'SERVICE';
  eventState?: string | null;
  transactionId?: string;
}) {
  return ENGINE.processPayout({
    transactionId: overrides.transactionId ?? 'TXN-TEST-1',
    grossAmountUSD: overrides.grossAmountUSD ?? 100,
    payee: profile(overrides.payee ?? {}),
    payoutType: overrides.payoutType ?? 'ROYALTY',
    eventState: overrides.eventState ?? null,
  });
}

describe('CovnantTaxEngineSDK.processPayout — US payees', () => {
  it('clears a verified US payee at zero federal withholding', () => {
    const result = resolve({});
    expect(result.withholdingTaxUSD).toBe(0);
    expect(result.stateSalesTaxUSD).toBe(0);
    expect(result.netClearingPayoutUSD).toBe(100);
    expect(result.lockState).toBe('CLEARED');
    expect(result.formTriggered).toBe('1099_MISC');
  });

  it('applies the 24 percent backup withholding with the lock when the TIN is PENDING', () => {
    const result = resolve({ payee: { tinStatus: 'PENDING' } });
    expect(result.withholdingTaxUSD).toBe(24);
    expect(result.netClearingPayoutUSD).toBe(76);
    expect(result.lockState).toBe('HELD_IN_TAX_ESCROW');
    expect(result.lockReason).toBe('INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING');
  });

  it('applies the 24 percent backup withholding with the lock when the TIN is INVALID', () => {
    const result = resolve({ payee: { tinStatus: 'INVALID' } });
    expect(result.withholdingTaxUSD).toBe(24);
    expect(result.lockReason).toBe('INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING');
  });

  it('triggers 1099_NEC for service payouts only at the cumulative $2,000 threshold', () => {
    // Below the threshold on cumulative YTD + gross: no form yet.
    const below = resolve({
      payoutType: 'SERVICE',
      grossAmountUSD: 1500,
      payee: { ytdClearedGrossUSD: 400 },
    });
    expect(below.formTriggered).toBe('EXEMPT_CORPORATE');

    // Crossing the threshold: the NEC fires (600 YTD + 1,500 = 2,100 >= 2,000).
    const crossing = resolve({
      payoutType: 'SERVICE',
      grossAmountUSD: 1500,
      payee: { ytdClearedGrossUSD: 600, formType: '1099_NEC' },
    });
    expect(crossing.formTriggered).toBe('1099_NEC');

    // The $2,000 founder-stated 2026 OBBBA threshold, exactly.
    expect(CovnantTaxEngineSDK.NEC_SERVICE_THRESHOLD).toBe(2000.0);
  });

  it('triggers 1099_MISC for royalty payouts at the cumulative $10 threshold', () => {
    const below = resolve({ grossAmountUSD: 5, payee: { ytdClearedGrossUSD: 0 } });
    expect(below.formTriggered).toBe('EXEMPT_CORPORATE');

    const crossing = resolve({ grossAmountUSD: 8, payee: { ytdClearedGrossUSD: 5 } });
    expect(crossing.formTriggered).toBe('1099_MISC');

    expect(CovnantTaxEngineSDK.MISC_ROYALTY_THRESHOLD).toBe(10.0);
  });

  it('keeps a corporate payee exempt regardless of thresholds', () => {
    const result = resolve({ payee: { formType: 'EXEMPT_CORPORATE' }, grossAmountUSD: 5000 });
    expect(result.formTriggered).toBe('EXEMPT_CORPORATE');
  });
});

describe('CovnantTaxEngineSDK.processPayout — foreign payees and treaties', () => {
  it('resolves a verified GB treaty royalty at 0.00 percent', () => {
    const result = resolve({
      payee: { countryCode: 'GB', usResident: false, treatyClaimActive: true, formType: 'W8_BEN' },
      payoutType: 'ROYALTY',
    });
    expect(result.withholdingTaxUSD).toBe(0);
    expect(result.lockState).toBe('CLEARED');
  });

  it('resolves a verified MX treaty royalty at the 0.10 treaty rate', () => {
    const result = resolve({
      payee: { countryCode: 'MX', usResident: false, treatyClaimActive: true, formType: 'W8_BEN' },
      payoutType: 'ROYALTY',
      grossAmountUSD: 100,
    });
    expect(result.withholdingTaxUSD).toBe(10);
    expect(result.netClearingPayoutUSD).toBe(90);
  });

  it('resolves a verified residence with no treaty at the 30 percent statutory fallback — cleared, no lock', () => {
    const result = resolve({
      payee: { countryCode: 'BR', usResident: false, treatyClaimActive: false, formType: 'W8_BEN_E' },
      payoutType: 'ROYALTY',
    });
    expect(result.withholdingTaxUSD).toBe(30);
    expect(result.lockState).toBe('CLEARED');
  });

  it('locks an unverified foreign payee at the mandatory 30 percent, forfeiting the treaty', () => {
    const result = resolve({
      payee: {
        countryCode: 'JP',
        tinStatus: 'UNSUBMITTED',
        usResident: false,
        treatyClaimActive: true,
        formType: 'W8_BEN',
      },
      payoutType: 'ROYALTY',
    });
    expect(result.withholdingTaxUSD).toBe(30);
    expect(result.lockState).toBe('HELD_IN_TAX_ESCROW');
    expect(result.lockReason).toBe('UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK');
  });

  it('does not extend a treaty royalty rate to a service payout', () => {
    const result = resolve({
      payee: { countryCode: 'GB', usResident: false, treatyClaimActive: true, formType: 'W8_BEN' },
      payoutType: 'SERVICE',
    });
    expect(result.withholdingTaxUSD).toBe(30);
    expect(result.lockState).toBe('CLEARED');
  });

  it('keeps the treaty table to the founder canon', () => {
    expect(CovnantTaxEngineSDK.TREATY_ROYALTY_RATES.GB).toBe(0.0);
    expect(CovnantTaxEngineSDK.TREATY_ROYALTY_RATES.MX).toBe(0.1);
    expect(CovnantTaxEngineSDK.TREATY_ROYALTY_RATES.AU).toBe(0.05);
    expect(CovnantTaxEngineSDK.TREATY_ROYALTY_RATES.IN).toBe(0.15);
    expect(CovnantTaxEngineSDK.TREATY_FALLBACK_RATE).toBe(0.3);
  });
});

describe('CovnantTaxEngineSDK.processPayout — state nexus and integer math', () => {
  it('layers the TX state nexus rate on top of federal withholding', () => {
    const result = resolve({
      payee: { tinStatus: 'PENDING', stateJurisdiction: 'TX' },
      eventState: 'TX',
      grossAmountUSD: 100,
    });
    expect(result.withholdingTaxUSD).toBe(24);
    expect(result.stateSalesTaxUSD).toBe(6.25);
    expect(result.netClearingPayoutUSD).toBe(69.75);
    expect(result.effectiveWithholdingRate).toBeCloseTo(0.3025, 6);
  });

  it('applies no state tax when the record carries no event state', () => {
    const result = resolve({ eventState: null, grossAmountUSD: 100 });
    expect(result.stateSalesTaxUSD).toBe(0);
  });

  it('resolves the net in integer cents — withholding plus state tax plus net equals gross', () => {
    const result = resolve({
      payee: { tinStatus: 'PENDING' },
      eventState: 'NY',
      grossAmountUSD: 123.45,
    });
    const cents = (usd: number) => Math.round(usd * 100);
    expect(cents(result.withholdingTaxUSD) + cents(result.stateSalesTaxUSD) + cents(result.netClearingPayoutUSD))
      .toBe(cents(result.grossAmountUSD));
  });
});
