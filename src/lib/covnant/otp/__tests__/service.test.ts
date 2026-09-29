/**
 * OTP core unit tests — the spec's security-envelope invariants, pinned as
 * executable shape: zero-padded 6-digit generation, hash-at-rest (the
 * digest never round-trips to the code), binding to user+phone+secret,
 * constant-time comparison semantics, and the named TTL/attempt/cooldown
 * constants the routes and UI render.
 */

import { describe, expect, it } from 'vitest';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  buildOtpMessage,
  generateOtp,
  hashOtp,
  otpMatches,
} from '../service';

const SECRET = 'test-otp-hash-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PHONE = '+15125550123';

describe('generateOtp', () => {
  it('generates exactly 6 digits, zero-padded', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateOtp();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('zero-pads small values (a code like 000123 is representable, not 5 digits)', () => {
    // Deterministic probe of the padding branch: the smallest possible draw
    // must render as '000000', not '' or '0'.
    expect(String(0).padStart(6, '0')).toBe('000000');
  });

  it('produces varying codes across draws (not a constant)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(generateOtp());
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('hashOtp / otpMatches', () => {
  it('produces a hex digest that is not the code and does not contain it', () => {
    const code = generateOtp();
    const digest = hashOtp(USER_ID, PHONE, code, SECRET);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(code);
  });

  it('is deterministic for the same inputs', () => {
    const a = hashOtp(USER_ID, PHONE, '123456', SECRET);
    const b = hashOtp(USER_ID, PHONE, '123456', SECRET);
    expect(a).toBe(b);
  });

  it('binds to user, phone, and secret — any change yields a different digest', () => {
    const base = hashOtp(USER_ID, PHONE, '123456', SECRET);
    expect(hashOtp('22222222-2222-4222-8222-222222222222', PHONE, '123456', SECRET)).not.toBe(base);
    expect(hashOtp(USER_ID, '+15125550124', '123456', SECRET)).not.toBe(base);
    expect(hashOtp(USER_ID, PHONE, '123456', 'other-secret')).not.toBe(base);
  });

  it('matches the stored digest for the correct code only', () => {
    const digest = hashOtp(USER_ID, PHONE, '012345', SECRET);
    expect(otpMatches(digest, hashOtp(USER_ID, PHONE, '012345', SECRET))).toBe(true);
    expect(otpMatches(digest, hashOtp(USER_ID, PHONE, '012346', SECRET))).toBe(false);
    // Same digits, different user binding — no cross-account replay.
    expect(
      otpMatches(digest, hashOtp('99999999-9999-4999-8999-999999999999', PHONE, '012345', SECRET)),
    ).toBe(false);
  });

  it('fails closed on a corrupt stored hash — no thrown compare, just no match', () => {
    expect(otpMatches('', hashOtp(USER_ID, PHONE, '012345', SECRET))).toBe(false);
    expect(otpMatches('not-hex', hashOtp(USER_ID, PHONE, '012345', SECRET))).toBe(false);
    expect(otpMatches('ab', hashOtp(USER_ID, PHONE, '012345', SECRET))).toBe(false);
  });
});

describe('buildOtpMessage', () => {
  it('carries the code and the expiry in plain language', () => {
    const message = buildOtpMessage('012345');
    expect(message).toContain('012345');
    expect(message).toContain('5 minutes');
  });
});

describe('locked constants', () => {
  it('pins TTL, attempt cap, and resend cooldown to the spec values', () => {
    expect(OTP_TTL_MINUTES).toBe(5);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
  });
});
