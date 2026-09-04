import { describe, expect, it } from 'vitest';
import {
  addMicro,
  allocateMicro,
  FixedPointParseError,
  formatFractionAsPercent,
  formatMicro,
  formatPercentUnits,
  formatPercentValue,
  microFromNumber,
  microToNumber,
  parseMicro,
  parsePercentUnits,
  percentNumberToUnits,
  percentUnitsToNumber,
  subMicro,
  tryParseMicro,
  tryParsePercentUnits,
} from '../fixed-point';
import { TARGET_UNITS } from '../splits/shared';

// The adapter constant is a number; the handler's target is its exact BigInt form.
const TARGET = BigInt(TARGET_UNITS);

describe('micro parsing and formatting (8 decimal places)', () => {
  it('round-trips exact decimal strings without float arithmetic', () => {
    expect(parseMicro('0.1')).toBe(10_000_000n);
    expect(parseMicro('1234.56789012')).toBe(123_456_789_012n);
    expect(formatMicro(parseMicro('1234.56789012'))).toBe('1234.56789012');
    expect(formatMicro(0n)).toBe('0.00000000');
  });

  it('adds and subtracts exactly — 0.1 + 0.2 is 0.3, the float path is not', () => {
    expect(addMicro(parseMicro('0.1'), parseMicro('0.2'))).toBe(parseMicro('0.3'));
    // The float path this module replaces, for contrast: 0.1 + 0.2 !== 0.3.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(subMicro(parseMicro('1'), parseMicro('0.00000001'))).toBe(parseMicro('0.99999999'));
  });

  it('sums a ledger worth of amounts with zero drift', () => {
    const amounts = ['100.00000001', '200.00000002', '300.00000004'];
    const total = amounts.reduce((acc, v) => addMicro(acc, parseMicro(v)), 0n);
    expect(formatMicro(total)).toBe('600.00000007');
  });

  it('rejects lossy or malformed input instead of silently rounding', () => {
    expect(() => parseMicro('0.123456789')).toThrow(FixedPointParseError);
    expect(() => parseMicro('1e-7')).toThrow(FixedPointParseError);
    expect(() => parseMicro('1,234.5')).toThrow(FixedPointParseError);
    expect(() => parseMicro('abc')).toThrow(FixedPointParseError);
    expect(tryParseMicro('0.123456789')).toBeNull();
    expect(tryParseMicro('12.5')).toBe(1_250_000_000n);
  });

  it('formats with display rounding (half-up) at fewer places', () => {
    expect(formatMicro(parseMicro('0.99999999'), 2)).toBe('1.00');
    expect(formatMicro(parseMicro('1234.5678'), 2)).toBe('1234.57');
    // Rounding to zero never renders a negative zero.
    expect(formatMicro(parseMicro('-0.004'), 2)).toBe('0.00');
    expect(formatMicro(parseMicro('-1.5'), 0)).toBe('-2');
  });
});

describe('dustless allocation', () => {
  it('recombines exactly to the allocated total', () => {
    for (const total of [1n, 2n, 7n, 100n, 999_999n, 100_000_000n]) {
      const parts = allocateMicro(total, [1n, 1n, 1n]);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });

  it('assigns the dust deterministically by largest remainder, then index', () => {
    // 100 split three equal ways: 34/33/33 — first index carries the extra unit.
    expect(allocateMicro(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    // Tied remainders resolve by index: the first part takes the single unit.
    expect(allocateMicro(1n, [1n, 1n, 1n])).toEqual([1n, 0n, 0n]);
  });

  it('allocates proportionally and still recombines exactly', () => {
    const parts = allocateMicro(100_000_000n, [60n, 40n]);
    expect(parts).toEqual([60_000_000n, 40_000_000n]);
    const uneven = allocateMicro(999n, [500n, 250n, 250n]);
    expect(uneven.reduce((a, b) => a + b, 0n)).toBe(999n);
  });

  it('rejects impossible allocations', () => {
    expect(() => allocateMicro(100n, [])).toThrow(RangeError);
    expect(() => allocateMicro(100n, [0n, 0n])).toThrow(RangeError);
    expect(() => allocateMicro(-1n, [1n])).toThrow(RangeError);
    expect(() => allocateMicro(100n, [1n, -1n])).toThrow(RangeError);
  });
});

describe('micro boundary adapters (number ⇄ units)', () => {
  it('enters integer space through the exact decimal string, not multiplication', () => {
    expect(microFromNumber(0.30000000000000004)).toBe(30_000_000n);
    expect(microFromNumber(1234.5678)).toBe(123_456_780_000n);
    expect(microFromNumber(-0.5)).toBe(-50_000_000n);
  });

  it('is lossless for realistic royalty magnitudes', () => {
    expect(microToNumber(123_456_780_000n)).toBe(1234.5678);
    expect(microToNumber(0n)).toBe(0);
  });

  it('refuses non-finite and absurd magnitudes', () => {
    expect(() => microFromNumber(Number.NaN)).toThrow(FixedPointParseError);
    expect(() => microFromNumber(Number.POSITIVE_INFINITY)).toThrow(FixedPointParseError);
    expect(() => microFromNumber(Number.MAX_SAFE_INTEGER)).toThrow(FixedPointParseError);
  });
});

describe('percent units for splits (4 decimal places, engine convention)', () => {
  it('maps engine percent numbers to exact units without float multiplication', () => {
    expect(percentNumberToUnits(33.3333)).toBe(333_333n);
    expect(percentNumberToUnits(0.0001)).toBe(1n);
    expect(percentNumberToUnits(100.0001)).toBe(1_000_001n);
    expect(percentNumberToUnits(100)).toBe(TARGET);
  });

  it('three 33.3333 shares reconcile to exactly 100.0000% in integer space', () => {
    const total = percentNumberToUnits(33.3333) * 2n + percentNumberToUnits(33.3334);
    expect(total).toBe(TARGET);
  });

  it('formats units back to 4-dp percent strings', () => {
    expect(formatPercentUnits(999_999n)).toBe('99.9999');
    expect(formatPercentUnits(TARGET)).toBe('100.0000');
    expect(formatPercentUnits(1n)).toBe('0.0001');
    expect(formatPercentUnits(1_000_001n)).toBe('100.0001');
  });

  it('round-trips through the engine number convention', () => {
    for (const units of [0n, 1n, 333_333n, 999_999n, TARGET, 1_000_001n]) {
      expect(percentNumberToUnits(percentUnitsToNumber(units))).toBe(units);
    }
    expect(percentUnitsToNumber(333_333n)).toBe(33.3333);
  });

  it('parses strict 4-dp strings and rejects excess precision', () => {
    expect(parsePercentUnits('33.3333')).toBe(333_333n);
    expect(parsePercentUnits('100')).toBe(TARGET);
    expect(() => parsePercentUnits('33.33335')).toThrow(FixedPointParseError);
    expect(tryParsePercentUnits('oops')).toBeNull();
  });

  it('formats percent values (not units) at 4 dp', () => {
    expect(formatPercentValue(33.3334)).toBe('33.3334');
    expect(formatPercentValue(100)).toBe('100.0000');
  });
});

describe('withholding-rate rendering', () => {
  it('renders a rate fraction as a percent string without float math', () => {
    expect(formatFractionAsPercent(0.1)).toBe('10.00');
    expect(formatFractionAsPercent(0)).toBe('0.00');
    expect(formatFractionAsPercent(0.125, 4)).toBe('12.5000');
    expect(formatFractionAsPercent(1)).toBe('100.00');
  });
});
