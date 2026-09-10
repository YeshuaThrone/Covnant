/**
 * Sign-in payload validation — the named-code grammar, exhaustively: the
 * honest branches, the normalization contract, and the password rule that
 * is deliberately NOT normalized.
 */

import { describe, expect, it } from 'vitest';

import { validateCovnantSigninPayload } from '@/lib/covnant/signinValidation';

describe('validateCovnantSigninPayload', () => {
  it('accepts a valid payload and normalizes the email (trim + lowercase)', () => {
    const result = validateCovnantSigninPayload({ email: '  Creator@Example.COM ', password: 'hunter22' });
    expect(result).toEqual({
      ok: true,
      value: { email: 'creator@example.com', password: 'hunter22' },
    });
  });

  it('never normalizes the password — a space is part of the secret', () => {
    const result = validateCovnantSigninPayload({ email: 'creator@example.com', password: ' padded ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.password).toBe(' padded ');
  });

  it('rejects a non-object body as malformed_body', () => {
    expect(validateCovnantSigninPayload(null)).toMatchObject({ ok: false, code: 'malformed_body' });
    expect(validateCovnantSigninPayload([1, 2])).toMatchObject({ ok: false, code: 'malformed_body' });
    expect(validateCovnantSigninPayload('nope')).toMatchObject({ ok: false, code: 'malformed_body' });
  });

  it('rejects a missing or blank email as missing_email', () => {
    expect(validateCovnantSigninPayload({ password: 'hunter22' })).toMatchObject({ ok: false, code: 'missing_email' });
    expect(validateCovnantSigninPayload({ email: '   ', password: 'hunter22' })).toMatchObject({ ok: false, code: 'missing_email' });
    expect(validateCovnantSigninPayload({ email: 7, password: 'hunter22' })).toMatchObject({ ok: false, code: 'missing_email' });
  });

  it('rejects a malformed email as invalid_email', () => {
    expect(validateCovnantSigninPayload({ email: 'not-an-email', password: 'hunter22' })).toMatchObject({ ok: false, code: 'invalid_email' });
    expect(validateCovnantSigninPayload({ email: 'a@b', password: 'hunter22' })).toMatchObject({ ok: false, code: 'invalid_email' });
  });

  it('rejects a missing or empty password as missing_password', () => {
    expect(validateCovnantSigninPayload({ email: 'creator@example.com' })).toMatchObject({ ok: false, code: 'missing_password' });
    expect(validateCovnantSigninPayload({ email: 'creator@example.com', password: '' })).toMatchObject({ ok: false, code: 'missing_password' });
    expect(validateCovnantSigninPayload({ email: 'creator@example.com', password: 12345678 })).toMatchObject({ ok: false, code: 'missing_password' });
  });

  it('carries brand-spelled, honest messages', () => {
    const result = validateCovnantSigninPayload({ email: 'nope', password: 'hunter22' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('email must be a valid email address.');
  });
});
