/**
 * The webhook shared-secret check — unit suite. The contract under test is
 * fail-closed (an unset configured secret refuses EVERYTHING), exact-match,
 * and constant-time (length mismatches normalize through the fixed-domain
 * HMAC so timingSafeEqual never throws and never leaks length early).
 */

import { describe, expect, it } from 'vitest';
import { sharedSecretMatches, timingSafeStringsEqual } from '../sharedSecret';

describe('sharedSecretMatches — fail-closed webhook check', () => {
  it('refuses everything when the configured secret is unset or empty', () => {
    expect(sharedSecretMatches('anything', undefined)).toBe(false);
    expect(sharedSecretMatches('anything', null)).toBe(false);
    expect(sharedSecretMatches('anything', '')).toBe(false);
  });

  it('refuses when nothing is presented, even with a secret configured', () => {
    expect(sharedSecretMatches(undefined, 'whsec_configured')).toBe(false);
    expect(sharedSecretMatches(null, 'whsec_configured')).toBe(false);
    expect(sharedSecretMatches('', 'whsec_configured')).toBe(false);
  });

  it('accepts only the exact configured secret', () => {
    expect(sharedSecretMatches('whsec_correct', 'whsec_correct')).toBe(true);
  });

  it('refuses any mismatch, including whitespace, case, and length games', () => {
    expect(sharedSecretMatches('whsec_wrong', 'whsec_correct')).toBe(false);
    expect(sharedSecretMatches('whsec_correct ', 'whsec_correct')).toBe(false);
    expect(sharedSecretMatches('whsec_correc', 'whsec_correct')).toBe(false);
    expect(sharedSecretMatches('WHSEC_CORRECT', 'whsec_correct')).toBe(false);
    expect(sharedSecretMatches('whsec_correctextra', 'whsec_correct')).toBe(false);
  });
});

describe('timingSafeStringsEqual — constant-time discipline', () => {
  it('equal strings compare true, differing strings false, and length mismatches never throw', () => {
    expect(timingSafeStringsEqual('same', 'same')).toBe(true);
    expect(timingSafeStringsEqual('short', 'a-much-longer-string')).toBe(false);
    expect(timingSafeStringsEqual('', '')).toBe(true);
    expect(timingSafeStringsEqual('a', 'b')).toBe(false);
  });
});
