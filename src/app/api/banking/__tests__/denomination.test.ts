import { describe, it, expect } from 'vitest';
import {
  centsToEngineUnits,
  engineUnitsToCents,
  SMALLEST_UNITS_PER_CENT,
  SubUnitRemainderError,
} from '../denomination';
import { withholdingUnitsOn } from '@/lib/escrow/balance';

/**
 * Banking denomination conversions: the flat ledger stores integer cents while
 * the shared escrow withholding helper runs in engine smallest units. Both
 * directions must be exact BigInt math, and the units→cents direction must
 * refuse a sub-cent remainder rather than round escrow dust.
 */

describe('banking denomination conversions', () => {
  it('maps one cent to 1,000,000 engine smallest units', () => {
    expect(SMALLEST_UNITS_PER_CENT).toBe(1_000_000n);
    expect(centsToEngineUnits(1n)).toBe(1_000_000n);
    expect(centsToEngineUnits(0n)).toBe(0n);
  });

  it('round-trips integer cents through engine units exactly, including huge values', () => {
    for (const cents of [
      1n,
      7n,
      25n,
      999n,
      100_000n,
      123_456_789n,
      9_007_199_254_740_992n,
      123_456_789_012_345_678_901_234_567_890n,
    ]) {
      expect(engineUnitsToCents(centsToEngineUnits(cents))).toBe(cents);
    }
  });

  it('throws SubUnitRemainderError when units are not a whole-cent multiple', () => {
    expect(() => engineUnitsToCents(1_000_001n)).toThrow(SubUnitRemainderError);
    expect(() => engineUnitsToCents(999_999n)).toThrow(SubUnitRemainderError);
    expect(() => engineUnitsToCents(-1n)).toThrow(SubUnitRemainderError);
  });

  it('keeps engine-rate withholding a whole-cent net for whole-cent requests', () => {
    // The engine works in smallest units at exact BigInt precision; the
    // route's ×10⁶ conversion must land the net back on a whole cent.
    for (const rate of [0.24, 0.3, 0]) {
      const units = centsToEngineUnits(100_000n);
      const net = engineUnitsToCents(units - withholdingUnitsOn(units, rate));
      expect(net % 1n).toBe(0n);
    }
    const units24 = centsToEngineUnits(100_000n);
    expect(engineUnitsToCents(units24 - withholdingUnitsOn(units24, 0.24))).toBe(76_000n);
  });
});
