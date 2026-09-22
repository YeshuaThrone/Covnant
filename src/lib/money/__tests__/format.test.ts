/**
 * Money formatting tests — the display edge of the ledger's BigInt
 * smallest-unit strings. Pins: exactness (no float, truncation-only
 * rounding, every significant digit on the minor figure), grouping only on
 * the WHOLE part (fraction grouping misreads as thousands), the true minus
 * sign, and per-currency suffixes.
 */

import { describe, expect, it } from 'vitest';

import {
  formatCents,
  formatCentsBigint,
  formatCentsSigned,
  formatUnitsMajor,
  formatUnitsMinor,
  formatUnitsSigned,
} from '@/lib/money/format';

describe('formatUnitsMajor — the primary figure', () => {
  it('renders whole units + two decimals, truncation-only', () => {
    expect(formatUnitsMajor('175000000', 'USD')).toBe('1.75 USD');
    expect(formatUnitsMajor('175012345', 'USD')).toBe('1.75 USD'); // never rounds up
    expect(formatUnitsMajor('0', 'USD')).toBe('0.00 USD');
  });

  it('groups the whole part on large sums', () => {
    expect(formatUnitsMajor('123456789012345', 'USD')).toBe('1,234,567.89 USD');
  });

  it('marks negatives with a true minus', () => {
    expect(formatUnitsMajor('-37000000', 'USD')).toBe('−0.37 USD');
  });
});

describe('formatUnitsMinor — the exact ledger figure', () => {
  it('renders every significant digit with an ungrouped fraction', () => {
    expect(formatUnitsMinor('175000000', 'USD')).toBe('1.75000000 USD');
    expect(formatUnitsMinor('123456789012345', 'USD')).toBe('1,234,567.89012345 USD');
    expect(formatUnitsMinor('1', 'USD')).toBe('0.00000001 USD');
  });

  it('keeps the exact fraction on negatives', () => {
    expect(formatUnitsMinor('-37000001', 'USD')).toBe('−0.37000001 USD');
  });
});

describe('formatCents — integer-cent vault display', () => {
  it('renders dollars from cents without floating-point arithmetic', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(129990)).toBe('$1,299.90');
    expect(formatCents(247830)).toBe('$2,478.30');
  });

  it('marks negatives with a true minus', () => {
    expect(formatCents(-91205)).toBe('−$912.05');
  });
});

describe('formatCentsSigned — signed GL display amounts', () => {
  it('signs inflows + and outflows with a true minus', () => {
    expect(formatCentsSigned(12990)).toBe('+$129.90');
    expect(formatCentsSigned(-91205)).toBe('−$912.05');
    expect(formatCentsSigned(0)).toBe('$0.00');
  });
});

describe('formatUnitsSigned — the withheld/outflow figure', () => {
  it('carries the same major-figure discipline', () => {
    expect(formatUnitsSigned('52500000', 'USD')).toBe('0.52 USD');
    expect(formatUnitsSigned('-52500000', 'USD')).toBe('−0.52 USD');
  });
});

describe('formatCentsBigint — the bigint-cent vault display', () => {
  it('renders dollars from bigint cents without floating-point arithmetic', () => {
    expect(formatCentsBigint(0n)).toBe('$0.00');
    expect(formatCentsBigint(5n)).toBe('$0.05');
    expect(formatCentsBigint(129990n)).toBe('$1,299.90');
    expect(formatCentsBigint(247830n)).toBe('$2,478.30');
  });

  it('matches the number-typed formatCents byte-for-byte inside its safe range', () => {
    for (const cents of [0, 5, 129990, 247830, -91205]) {
      expect(formatCentsBigint(BigInt(cents))).toBe(formatCents(cents));
    }
  });

  it('marks negatives with a true minus', () => {
    expect(formatCentsBigint(-91205n)).toBe('−$912.05');
  });

  it('groups the whole part at billion-dollar magnitudes', () => {
    expect(formatCentsBigint(100_000_000_000n)).toBe('$1,000,000,000.00');
    expect(formatCentsBigint(200_000_000_000n)).toBe('$2,000,000,000.00');
  });

  it('stays exact past Number.MAX_SAFE_INTEGER cents — where the float path cannot', () => {
    expect(formatCentsBigint(9007199254740999n)).toBe('$90,071,992,547,409.99');
  });
});
