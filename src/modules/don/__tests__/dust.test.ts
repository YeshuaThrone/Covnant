import { describe, expect, it } from 'vitest';
import {
  allocateWithCompanyDustSweep,
  percentToBps,
  sumAllocatedCents,
  sumBps,
  zeroBalanceHolds,
} from '../dust';
import { allocateCents, allocateLineItems } from '@/lib/don/splitEngine';
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
} from '../constants';
import type { SplitPartyInput } from '@/lib/don/types';

/**
 * Don Engine locked allocation invariants (Gen 14, spec criteria 1 and 2).
 *
 * The split math is Cursor's, copied verbatim; these tests are the lock, not
 * a reimplementation. Every allocation must balance to the gross line item in
 * integer cents: sum(creator allocations) + company_dust === gross, floor-only
 * arithmetic, no floats. Dust belongs to the platform variance payee — it may
 * never surface inside a creator allocation.
 */

function party(
  payee_id: string,
  share_bps: number,
  role: SplitPartyInput['role'] = 'creator',
): SplitPartyInput {
  return { payee_id, payee_name: `Payee ${payee_id}`, role, share_bps };
}

// Split sets that each sum to exactly 10,000 bps. 50/50 divides cleanly;
// 3333/3333/3334 is the classic dust split (three-way, one survivor);
// 1 bps against 9999 makes floor allocation produce dust on nearly any gross.
const BALANCED_SPLIT_SETS: SplitPartyInput[][] = [
  [party('creator_a', 5_000), party('creator_b', 5_000)],
  [party('creator_a', 3_333), party('creator_b', 3_333), party('creator_c', 3_334)],
  [party('creator_a', 9_999), party('creator_b', 1)],
  [party('creator_a', 1), party('creator_b', 9_999)],
  [party('creator_a', 2_500), party('label_x', 2_500), party('publisher_y', 2_500), party('creator_b', 2_499), party('creator_c', 1)],
  [party('creator_a', 10_000)],
];

// Gross line items in cents: 1-cent, small odd values, the $600 1099
// boundary, dust-heavy sums, and large values (still safely inside
// Number.MAX_SAFE_INTEGER once multiplied by share_bps).
const GROSS_CENTS_CASES = [
  1,
  2,
  3,
  7,
  33,
  99,
  101,
  999,
  5_999,
  6_000,
  60_000,
  123_457,
  1_000_000,
  100_000_000_000,
];

describe('don dust allocation — zero-balance invariant (criterion 1)', () => {
  it('balances every gross against every balanced split set, exactly, in integer cents', () => {
    for (const gross of GROSS_CENTS_CASES) {
      for (const splits of BALANCED_SPLIT_SETS) {
        const result = allocateWithCompanyDustSweep(gross, splits);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;

        const allocatedTotal = sumAllocatedCents(result.splits);
        expect(allocatedTotal + result.company_dust_cents).toBe(gross);
      }
    }
  });

  it('allocates floor-only integer cents — no floats, ever', () => {
    for (const gross of GROSS_CENTS_CASES) {
      for (const splits of BALANCED_SPLIT_SETS) {
        const result = allocateWithCompanyDustSweep(gross, splits);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;

        for (const split of result.splits) {
          expect(Number.isInteger(split.amount_cents)).toBe(true);
          // No creator may receive more than their exact floor share —
          // dust cannot hide inside an allocation.
          expect(split.amount_cents).toBe(
            Math.floor((gross * split.share_bps) / BPS_DENOMINATOR),
          );
        }
        expect(Number.isInteger(result.company_dust_cents)).toBe(true);
      }
    }
  });

  it('sweeps the dust remainder to the platform, never onto a creator payee', () => {
    for (const gross of GROSS_CENTS_CASES) {
      for (const splits of BALANCED_SPLIT_SETS) {
        const result = allocateWithCompanyDustSweep(gross, splits);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;

        // The only unattributed cents are company_dust_cents, which the
        // wiring credits to the platform variance payee alone.
        expect(gross - sumAllocatedCents(result.splits)).toBe(
          result.company_dust_cents,
        );
        expect(result.company_dust_cents).toBeGreaterThanOrEqual(0);
      }
    }

    // The wiring binds dust rows to this payee; pin it so a renamed
    // variance payee cannot silently reroute creator dust.
    expect(COMPANY_VARIANCE_PAYEE_ID).toBe('platform');
    expect(COMPANY_VARIANCE_PAYEE_NAME).toBe('Don Engine Variance');
  });

  it('sends the whole cent to dust on a 1-cent gross split 50/50', () => {
    const result = allocateWithCompanyDustSweep(1, [
      party('creator_a', 5_000),
      party('creator_b', 5_000),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sumAllocatedCents(result.splits)).toBe(0);
    expect(result.company_dust_cents).toBe(1);
  });

  it('handles dust-heavy allocations where dust exceeds any single share', () => {
    // 3 cents across 3333/3333/3334 bps: floor leaves 2 of 3 cents to dust.
    const result = allocateWithCompanyDustSweep(3, [
      party('creator_a', 3_333),
      party('creator_b', 3_333),
      party('creator_c', 3_334),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sumAllocatedCents(result.splits)).toBe(1);
    expect(result.company_dust_cents).toBe(2);
    expect(sumAllocatedCents(result.splits) + result.company_dust_cents).toBe(3);
  });

  it('produces zero dust when every share divides the gross exactly', () => {
    const result = allocateWithCompanyDustSweep(10_000, [
      party('creator_a', 5_000),
      party('creator_b', 5_000),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company_dust_cents).toBe(0);
    expect(sumAllocatedCents(result.splits)).toBe(10_000);
  });

  it('keeps zeroBalanceHolds as the exact zero-balance predicate', () => {
    for (const gross of GROSS_CENTS_CASES) {
      for (const splits of BALANCED_SPLIT_SETS) {
        const result = allocateWithCompanyDustSweep(gross, splits);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(zeroBalanceHolds(gross, result.splits, result.company_dust_cents)).toBe(true);
        // One cent of leakage breaks it — this is the 500 guard in the wiring.
        expect(zeroBalanceHolds(gross, result.splits, result.company_dust_cents + 1)).toBe(false);
      }
    }
  });
});

describe('don dust allocation — splits_do_not_balance', () => {
  it('rejects split sets that do not sum to 10000 bps', () => {
    const unbalanced: Array<{ splits: SplitPartyInput[]; total: number }> = [
      { splits: [party('creator_a', 9_999)], total: 9_999 },
      { splits: [party('creator_a', 10_001)], total: 10_001 },
      { splits: [], total: 0 },
      {
        splits: [party('creator_a', 5_000), party('creator_b', 4_999)],
        total: 9_999,
      },
      {
        splits: [party('creator_a', 10_000), party('creator_b', 10_000)],
        total: 20_000,
      },
    ];

    for (const { splits, total } of unbalanced) {
      const result = allocateWithCompanyDustSweep(60_000, splits);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe('splits_do_not_balance');
      expect(result.message).toBe(
        `Party shares must sum to 10000 bps (100%), got ${total}.`,
      );
    }
  });

  it('never allocates a single cent when the split set is unbalanced', () => {
    const result = allocateWithCompanyDustSweep(999, [party('creator_a', 9_999)]);
    expect(result.ok).toBe(false);
  });
});

describe('don bps helpers', () => {
  it('converts percent to bps with round-half behavior', () => {
    expect(percentToBps(100)).toBe(10_000);
    expect(percentToBps(24)).toBe(2_400);
    expect(percentToBps(0.5)).toBe(50);
    expect(percentToBps(33.33)).toBe(3_333);
  });

  it('sums share_bps across a split set', () => {
    expect(sumBps(BALANCED_SPLIT_SETS[0]!)).toBe(10_000);
    expect(sumBps(BALANCED_SPLIT_SETS[4]!)).toBe(10_000);
    expect(sumBps([party('creator_a', 9_999)])).toBe(9_999);
  });
});

describe('don split engine facade (lib/don/splitEngine)', () => {
  it('allocates through allocateCents with the same dust sweep', () => {
    const viaFacade = allocateCents(123_457, [
      party('creator_a', 3_333),
      party('creator_b', 3_333),
      party('creator_c', 3_334),
    ]);
    const direct = allocateWithCompanyDustSweep(123_457, [
      party('creator_a', 3_333),
      party('creator_b', 3_333),
      party('creator_c', 3_334),
    ]);
    expect(viaFacade).toEqual(direct);
  });

  it('aggregates gross and variance cents across multiple line items', () => {
    const result = allocateLineItems([
      {
        work_id: 'work_1',
        work_title: 'Song One',
        amount_cents: 100_000,
        splits: [party('creator_a', 5_000), party('creator_b', 5_000)],
      },
      {
        work_id: 'work_2',
        work_title: 'Song Two',
        amount_cents: 3,
        splits: [
          party('creator_a', 3_333),
          party('creator_b', 3_333),
          party('creator_c', 3_334),
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grossCents).toBe(100_003);
    expect(result.varianceAccountCents).toBe(0 + 2);
    expect(result.items).toHaveLength(2);

    // Whole-batch zero balance: every line item balances individually.
    for (const item of result.items) {
      expect(sumAllocatedCents(item.splits) + item.company_dust_cents).toBe(
        item.amount_cents,
      );
    }
  });

  it('propagates splits_do_not_balance from any line item in the batch', () => {
    const result = allocateLineItems([
      {
        work_id: 'work_1',
        work_title: 'Song One',
        amount_cents: 100_000,
        splits: [party('creator_a', 5_000), party('creator_b', 5_000)],
      },
      {
        work_id: 'work_2',
        work_title: 'Song Two',
        amount_cents: 50,
        splits: [party('creator_a', 9_999)],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('splits_do_not_balance');
  });
});
