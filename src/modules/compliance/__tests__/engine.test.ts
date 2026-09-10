import { describe, expect, it, vi } from 'vitest';
import { readCreatorCompliance, type ComplianceStore } from '../engine';
import {
  CreatorTaxProfile,
  CreatorYtdEarnings,
  TaxEscrowRecord,
} from '@/modules/don/records';
import { FORM_1099_THRESHOLD_CENTS } from '@/modules/don/constants';

/**
 * Don Engine compliance snapshot (Gen 14, part of spec criterion 3).
 *
 * readCreatorCompliance is Cursor's Phase 2 read path: TIN/W-9 flags come off
 * the stored tax profile (integer 0/1), YTD and escrow come off the store, and
 * requires_1099 flips at exactly 60,000 cents ($600). The withholding math
 * itself (floor(gross x 2400/10000)) arrives with the Phase 2 engine drop and
 * is tested there — this file locks the snapshot behavior against a store
 * mock per the function's signature.
 */

const TAX_YEAR = 2026;

function taxProfile(overrides: Partial<CreatorTaxProfile> = {}): CreatorTaxProfile {
  return {
    creator_id: 'creator_1',
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function ytd(overrides: Partial<CreatorYtdEarnings> = {}): CreatorYtdEarnings {
  return {
    creator_id: 'creator_1',
    tax_year: TAX_YEAR,
    gross_cents: 0,
    withheld_cents: 0,
    updated_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function escrowRow(overrides: Partial<TaxEscrowRecord> = {}): TaxEscrowRecord {
  return {
    id: 'escrow_1',
    creator_id: 'creator_1',
    tax_year: TAX_YEAR,
    gross_cents: 10_000,
    withheld_cents: 2_400,
    net_cents: 7_600,
    tin_verified: 0,
    w9_on_file: 0,
    requires_1099: 0,
    crossed_1099_threshold: 0,
    created_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function mockStore(overrides: {
  profile?: CreatorTaxProfile | null;
  ytd?: CreatorYtdEarnings | null;
  escrow?: TaxEscrowRecord[];
} = {}): ComplianceStore {
  return {
    getCreatorTaxProfile: vi.fn(() =>
      overrides.profile === undefined ? taxProfile() : overrides.profile,
    ),
    getCreatorYtd: vi.fn(() =>
      overrides.ytd === undefined ? ytd() : overrides.ytd,
    ),
    listTaxEscrowByCreator: vi.fn(() => overrides.escrow ?? []),
  };
}

describe('readCreatorCompliance', () => {
  it('reports verified TIN and W-9 as true', () => {
    const store = mockStore({ profile: taxProfile({ tin_verified: 1, w9_on_file: 1 }) });
    const snapshot = readCreatorCompliance(store, 'creator_1', TAX_YEAR);
    expect(snapshot.tin_verified).toBe(true);
    expect(snapshot.w9_on_file).toBe(true);
  });

  it('reports unverified TIN and W-9 as false', () => {
    const store = mockStore({ profile: taxProfile({ tin_verified: 0, w9_on_file: 0 }) });
    const snapshot = readCreatorCompliance(store, 'creator_1', TAX_YEAR);
    expect(snapshot.tin_verified).toBe(false);
    expect(snapshot.w9_on_file).toBe(false);
  });

  it('treats a missing tax profile as fully unverified', () => {
    const store = mockStore({ profile: null });
    const snapshot = readCreatorCompliance(store, 'creator_1', TAX_YEAR);
    expect(snapshot.tin_verified).toBe(false);
    expect(snapshot.w9_on_file).toBe(false);
  });

  it('does not count a lone verified flag — both flags must be 1', () => {
    const store = mockStore({
      profile: taxProfile({ tin_verified: 1, w9_on_file: 0 }),
    });
    const snapshot = readCreatorCompliance(store, 'creator_1', TAX_YEAR);
    expect(snapshot.tin_verified).toBe(true);
    expect(snapshot.w9_on_file).toBe(false);
  });

  it('passes YTD gross and withheld cents through', () => {
    const store = mockStore({
      ytd: ytd({ gross_cents: 123_456, withheld_cents: 29_629 }),
    });
    const snapshot = readCreatorCompliance(store, 'creator_1', TAX_YEAR);
    expect(snapshot.ytd_gross_cents).toBe(123_456);
    expect(snapshot.ytd_withheld_cents).toBe(29_629);
  });

  it('reports zero YTD when no earnings row exists', () => {
    const store = mockStore({ ytd: null });
    const snapshot = readCreatorCompliance(store, 'creator_1', TAX_YEAR);
    expect(snapshot.ytd_gross_cents).toBe(0);
    expect(snapshot.ytd_withheld_cents).toBe(0);
    expect(snapshot.requires_1099).toBe(false);
  });

  it('flips requires_1099 exactly at the $600 threshold (60,000 cents)', () => {
    expect(FORM_1099_THRESHOLD_CENTS).toBe(60_000);
    const below = readCreatorCompliance(
      mockStore({ ytd: ytd({ gross_cents: FORM_1099_THRESHOLD_CENTS - 1 }) }),
      'creator_1',
      TAX_YEAR,
    );
    expect(below.requires_1099).toBe(false);

    const at = readCreatorCompliance(
      mockStore({ ytd: ytd({ gross_cents: FORM_1099_THRESHOLD_CENTS }) }),
      'creator_1',
      TAX_YEAR,
    );
    expect(at.requires_1099).toBe(true);

    const above = readCreatorCompliance(
      mockStore({ ytd: ytd({ gross_cents: FORM_1099_THRESHOLD_CENTS + 1 }) }),
      'creator_1',
      TAX_YEAR,
    );
    expect(above.requires_1099).toBe(true);
  });

  it('returns the creator escrow history untouched', () => {
    const rows = [
      escrowRow(),
      escrowRow({ id: 'escrow_2', gross_cents: 500, withheld_cents: 120, net_cents: 380 }),
    ];
    const store = mockStore({ escrow: rows });
    const snapshot = readCreatorCompliance(store, 'creator_1', TAX_YEAR);
    expect(snapshot.escrow).toEqual(rows);
  });

  it('queries the store with the requested creator and tax year', () => {
    const store = mockStore();
    readCreatorCompliance(store, 'creator_9', 2025);
    expect(store.getCreatorTaxProfile).toHaveBeenCalledWith('creator_9');
    expect(store.getCreatorYtd).toHaveBeenCalledWith('creator_9', 2025);
    expect(store.listTaxEscrowByCreator).toHaveBeenCalledWith('creator_9', 2025);
  });

  it('echoes the creator and tax year in the snapshot', () => {
    const snapshot = readCreatorCompliance(mockStore(), 'creator_7', 2024);
    expect(snapshot.creator_id).toBe('creator_7');
    expect(snapshot.tax_year).toBe(2024);
  });
});
