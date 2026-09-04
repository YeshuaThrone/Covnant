import { describe, expect, it } from 'vitest';
import type { LedgerRow } from '../../ledger/store';
import type { AgreementContext } from '../generator';
import { payoutFlowsFor } from '../payouts';

function makeContext(): AgreementContext {
  return {
    asset: {
      title: 'E2E Pool Gate Song',
      mediumLabel: 'Music Track',
      cbtCode: 'CBT-TRK-4A3F2879BD05',
      displayCode: 'CVT-TRK-4A3F2879BD05',
      identifiers: [],
    },
    pools: [
      {
        pool: 'MASTER_RECORDING',
        label: 'Master Recording',
        totalPercent: '100.0000',
        holders: [
          { name: 'Alice E2E', role: 'COMPOSER', pools: 'Master Recording', sharePercent: '60.0000' },
          { name: 'Bob E2E', role: 'PRODUCER', pools: 'Master Recording', sharePercent: '40.0000' },
        ],
      },
    ],
    parties: [],
    fields: {
      effectiveDate: '',
      territory: 'Worldwide',
      term: 'Twelve (12) months from the Effective Date',
      fee: 'As separately agreed in writing between the Parties',
      governingLaw: 'the State of Delaware, United States',
    },
  };
}

let sequence = 0;

function makeRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  sequence += 1;
  return {
    transactionId: `TXN-${String(sequence).padStart(4, '0')}`,
    cbtCode: 'CBT-TRK-4A3F2879BD05',
    platform: 'Spotify',
    grossSettled: 1000,
    covenantFee: 100,
    cornerDustCollected: 1,
    currency: 'USD',
    disbursements: [
      {
        rightsHolderId: 'h1',
        rightsHolderName: 'Alice E2E',
        role: 'COMPOSER',
        grossShare: 600,
        withholdingTaxRateApplied: 0,
        withholdingTaxDeducted: 0,
        netShare: 600,
        currency: 'USD',
        isTaxReportable: false,
        taxFormRequired: 'NONE',
        routing: {
          accountHolderName: 'Alice E2E',
          bankName: 'Test Bank',
          accountNumberOrIBAN: '000123456',
          routingOrBIC: '012345678',
          currency: 'USD',
          countryCode: 'US',
          planetaryJurisdiction: 'EARTH',
          railType: 'ACH',
        },
      },
      {
        rightsHolderId: 'h2',
        rightsHolderName: 'Unlisted Party',
        role: 'PRODUCER',
        grossShare: 300,
        withholdingTaxRateApplied: 0.1,
        withholdingTaxDeducted: 30,
        netShare: 270,
        currency: 'USD',
        isTaxReportable: false,
        taxFormRequired: 'NONE',
        routing: {
          accountHolderName: 'Unlisted Party',
          bankName: 'Test Bank',
          accountNumberOrIBAN: '000123456',
          routingOrBIC: '012345678',
          currency: 'USD',
          countryCode: 'US',
          planetaryJurisdiction: 'EARTH',
          railType: 'ACH',
        },
      },
    ],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('payoutFlowsFor', () => {
  it('pairs each disbursement with the holder’s recorded split from the agreement', () => {
    const { flows, totals } = payoutFlowsFor('CBT-TRK-4A3F2879BD05', makeContext(), [makeRow()]);
    expect(flows).toHaveLength(1);
    expect(flows[0].lines[0]).toMatchObject({
      holder: 'Alice E2E',
      role: 'COMPOSER',
      recordedPercent: '60.0000',
      grossShare: 600,
      netShare: 600,
    });
    // Disbursements for parties off the agreement sheet still render, without
    // an invented recorded percentage.
    expect(flows[0].lines[1].recordedPercent).toBeUndefined();
    expect(totals).toEqual([
      { currency: 'USD', gross: 1000, fees: 100, net: 870, settlements: 1 },
    ]);
  });

  it('filters strictly to the agreement’s asset of record and aggregates per currency', () => {
    const other = makeRow({ cbtCode: 'CBT-OTHER', platform: 'AppleMusic' });
    const eur = makeRow({ currency: 'EUR', grossSettled: 500, covenantFee: 50 });
    const { flows, totals } = payoutFlowsFor('CBT-TRK-4A3F2879BD05', makeContext(), [
      other,
      eur,
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].platform).toBe('Spotify');
    // Net is the total actually disbursed to holders (Σ netShare), scoped per currency.
    expect(totals).toEqual([
      { currency: 'EUR', gross: 500, fees: 50, net: 870, settlements: 1 },
    ]);
  });

  it('renders an empty result — no fabricated flows — when nothing has settled', () => {
    const { flows, totals } = payoutFlowsFor('CBT-TRK-4A3F2879BD05', makeContext(), []);
    expect(flows).toEqual([]);
    expect(totals).toEqual([]);
  });
});
