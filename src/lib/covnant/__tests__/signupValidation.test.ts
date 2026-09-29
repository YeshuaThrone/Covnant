import { describe, expect, it } from 'vitest';

import { normalizeOptionalE164 } from '../signupValidation';
import { normalizePhoneInput } from '../../phone';

/**
 * The phone normalization gates — any real-world capture becomes canonical
 * E.164, and only input that cannot be a real number is rejected. The
 * founder's number (830-358-2306, rejected by the old strict matcher) is
 * the anchor case.
 */

describe('normalizePhoneInput', () => {
  it.each([
    ['830-358-2306', '+18303582306'],
    ['8303582306', '+18303582306'],
    ['(830) 358-2306', '+18303582306'],
    ['830.358.2306', '+18303582306'],
    ['+1 830 358 2306', '+18303582306'],
    ['1-830-358-2306', '+18303582306'],
  ])('normalizes the founder-class US capture %s to %s', (captured, canonical) => {
    expect(normalizePhoneInput(captured)).toBe(canonical);
  });

  it('passes a canonical E.164 number through unchanged', () => {
    expect(normalizePhoneInput('+15125550123')).toBe('+15125550123');
  });

  it('passes a non-US E.164 number through unchanged (no US rewrite)', () => {
    expect(normalizePhoneInput('+447700900123')).toBe('+447700900123');
  });

  it('treats surrounding whitespace as absent', () => {
    expect(normalizePhoneInput('  830-358-2306  ')).toBe('+18303582306');
  });

  it.each([
    ['too short — 123', '123'],
    ['letters — not-a-phone', 'not-a-phone'],
    ['extension — 830-358-2306 ext 5', '830-358-2306 ext 5'],
    ['plus-prefixed too short — +1234567', '+1234567'],
    ['plus-prefixed too long — 16 digits', '+1234567890123456'],
    ['a lone plus', '+'],
  ])('rejects %s (no canonical reading → null)', (_label, captured) => {
    expect(normalizePhoneInput(captured)).toBeNull();
  });
});

describe('normalizeOptionalE164', () => {
  it('maps undefined and null to ok with a null phone', () => {
    expect(normalizeOptionalE164(undefined)).toEqual({ ok: true, phone: null });
    expect(normalizeOptionalE164(null)).toEqual({ ok: true, phone: null });
  });

  it('maps a blank capture to ok with a null phone', () => {
    expect(normalizeOptionalE164('')).toEqual({ ok: true, phone: null });
    expect(normalizeOptionalE164('   ')).toEqual({ ok: true, phone: null });
  });

  it('rejects a non-string phone', () => {
    expect(normalizeOptionalE164(5125550123)).toEqual({ ok: false });
    expect(normalizeOptionalE164([])).toEqual({ ok: false });
  });

  it('normalizes a real-world format to canonical E.164', () => {
    expect(normalizeOptionalE164('830-358-2306')).toEqual({
      ok: true,
      phone: '+18303582306',
    });
  });

  it('rejects input that cannot be a real number', () => {
    expect(normalizeOptionalE164('not-a-phone')).toEqual({ ok: false });
    expect(normalizeOptionalE164('123')).toEqual({ ok: false });
  });
});
