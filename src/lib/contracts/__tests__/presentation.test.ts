import { describe, expect, it } from 'vitest';
import type { AgreementContext } from '../generator';
import {
  autoFillSummary,
  presentationStatus,
  signatureRows,
  signatureStorageKey,
} from '../presentation';

function makeContext(overrides: Partial<AgreementContext> = {}): AgreementContext {
  return {
    asset: {
      title: 'E2E Pool Gate Song',
      mediumLabel: 'Music Track',
      cbtCode: 'CBT-TRK-4A3F2879BD05',
      displayCode: 'CVT-TRK-4A3F2879BD05',
      identifiers: [{ label: 'ISRC', value: 'US-S1M-26-77777' }],
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
    parties: [
      {
        name: 'Alice E2E',
        role: 'COMPOSER',
        pools: 'Master Recording',
        sharePercent: '60.0000',
        ipi: '00456789123',
      },
      { name: 'Bob E2E', role: 'PRODUCER', pools: 'Master Recording', sharePercent: '40.0000' },
    ],
    fields: {
      effectiveDate: '',
      territory: 'Worldwide',
      term: 'Twelve (12) months from the Effective Date',
      fee: 'As separately agreed in writing between the Parties',
      governingLaw: 'the State of Delaware, United States',
    },
    ...overrides,
  };
}

describe('presentationStatus', () => {
  it('maps FINAL to Completed regardless of signature state', () => {
    expect(presentationStatus('FINAL', false)).toBe('Completed');
    expect(presentationStatus('FINAL', true)).toBe('Completed');
  });

  it('maps DRAFT to Pending exactly when a signature has been requested', () => {
    expect(presentationStatus('DRAFT', false)).toBe('Draft');
    expect(presentationStatus('DRAFT', true)).toBe('Pending');
  });
});

describe('signatureRows / signatureStorageKey', () => {
  it('keys rows by name::role in party order', () => {
    const rows = signatureRows(makeContext().parties);
    expect(rows.map((r) => r.key)).toEqual(['Alice E2E::COMPOSER', 'Bob E2E::PRODUCER']);
  });

  it('scopes the storage key by contract when saved, by draft coordinates otherwise', () => {
    expect(signatureStorageKey('CTR-EA3C707D', 'CBT-1', 'MUSIC_SPLIT_SHEET')).toBe(
      'covnant-signatures:CTR-EA3C707D',
    );
    expect(signatureStorageKey(undefined, 'CBT-1', 'MUSIC_SPLIT_SHEET')).toBe(
      'covnant-signatures:draft:CBT-1:MUSIC_SPLIT_SHEET',
    );
  });
});

describe('autoFillSummary', () => {
  it('echoes only registered data: names, roles, exact splits, and identifiers', () => {
    const summary = autoFillSummary(makeContext());
    expect(summary.work.cbtCode).toBe('CBT-TRK-4A3F2879BD05');
    expect(summary.identifiers).toEqual([
      { label: 'CBT', value: 'CBT-TRK-4A3F2879BD05', toBeCompleted: false },
      { label: 'CVT', value: 'CVT-TRK-4A3F2879BD05', toBeCompleted: false },
      { label: 'ISRC', value: 'US-S1M-26-77777', toBeCompleted: false },
    ]);
    expect(summary.parties[0].sharePercent).toBe('60.0000');
  });

  it('never fabricates missing holder profile data — renders to-be-completed', () => {
    const summary = autoFillSummary(makeContext());
    // Alice carries an IPI but no ISNI; Bob carries neither.
    expect(summary.parties[0].identifiers).toEqual([
      { label: 'ISNI', value: 'To be completed', toBeCompleted: true },
      { label: 'IPI (PRO)', value: '00456789123', toBeCompleted: false },
    ]);
    expect(summary.parties[1].identifiers).toEqual([
      { label: 'ISNI', value: 'To be completed', toBeCompleted: true },
      { label: 'IPI (PRO)', value: 'To be completed', toBeCompleted: true },
    ]);
  });

  it('is deterministic — identical contexts yield identical summaries', () => {
    expect(autoFillSummary(makeContext())).toEqual(autoFillSummary(makeContext()));
  });
});
