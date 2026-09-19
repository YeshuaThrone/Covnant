/**
 * SyncLicenseForm fee-floor parsing — the dollar fee floor (F-directive).
 * Whole dollars only, converted to integer cents; fractional and invalid
 * inputs are rejected (null), never coerced.
 */

import { describe, expect, it } from 'vitest';

import { parseDollarFeeToCents } from '../SyncLicenseForm';

describe('parseDollarFeeToCents — the dollar fee floor', () => {
  it('parses whole dollars to integer cents', () => {
    expect(parseDollarFeeToCents('4950')).toBe(495_000);
    expect(parseDollarFeeToCents('1')).toBe(100);
    expect(parseDollarFeeToCents('$3,200')).toBe(320_000);
  });

  it('accepts surrounding whitespace and a leading dollar sign', () => {
    expect(parseDollarFeeToCents('  250 ')).toBe(25_000);
    expect(parseDollarFeeToCents('$99')).toBe(9_900);
  });

  it('rejects cent fractions — the floor is whole dollars', () => {
    expect(parseDollarFeeToCents('49.99')).toBeNull();
    expect(parseDollarFeeToCents('0.5')).toBeNull();
  });

  it('rejects zero, negatives, and non-numeric input', () => {
    expect(parseDollarFeeToCents('0')).toBeNull();
    expect(parseDollarFeeToCents('-5')).toBeNull();
    expect(parseDollarFeeToCents('abc')).toBeNull();
    expect(parseDollarFeeToCents('')).toBeNull();
  });
});
