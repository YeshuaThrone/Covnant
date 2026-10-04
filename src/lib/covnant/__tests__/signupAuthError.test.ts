import { describe, expect, it } from 'vitest';

import { signupAuthError } from '../covnantSignup';
import { validateSignupEmail } from '../signupValidation';

/**
 * The pure classification gates of the email-verification path:
 *
 * - signupAuthError maps the raw GoTrue signUp failure onto HTTP semantics.
 *   The documented 2026-09-27 hazard is anchored: an exhausted built-in SMTP
 *   quota surfaces as a misleading 400 "Email address ... is invalid" — the
 *   fail-closed 503 email_send_failed, never a line a visitor reads as "my
 *   email is wrong", and never worked around with external SMTP (founder
 *   approval required).
 * - validateSignupEmail is the single email rule the signup payload and the
 *   resend route share.
 */

describe('signupAuthError', () => {
  it('maps the masked SMTP-quota failure to the fail-closed 503 clean-retry state', () => {
    const failure = signupAuthError('Email address "creator@example.com" is invalid');
    expect(failure).toMatchObject({
      ok: false,
      status: 503,
      code: 'email_send_failed',
    });
    // The visitor is never told their email is wrong; the raw GoTrue line
    // never reaches the response.
    expect(failure.message).not.toContain('invalid');
    expect(failure.message).not.toContain('creator@example.com');
    expect(failure.message).toContain('submit again in a minute');
  });

  it('maps an explicit rate-limit message to the 429 cooldown', () => {
    expect(
      signupAuthError('Signups are rate limited: once every 60 seconds'),
    ).toMatchObject({ ok: false, status: 429, code: 'email_send_rate_limited' });
    expect(signupAuthError('Too many requests')).toMatchObject({
      ok: false,
      status: 429,
      code: 'email_send_rate_limited',
    });
  });

  it('leaves a genuine rejection as the sanitized 400 auth_signup_failed', () => {
    expect(signupAuthError('User already registered')).toMatchObject({
      ok: false,
      status: 400,
      code: 'auth_signup_failed',
      message: 'User already registered',
    });
  });

  it('falls back to the neutral message when GoTrue sends no message', () => {
    expect(signupAuthError(undefined)).toMatchObject({
      ok: false,
      status: 400,
      code: 'auth_signup_failed',
      message: 'Unable to create credentials.',
    });
  });
});

describe('validateSignupEmail', () => {
  it('trims and lowercases the address — the signup payload normalization', () => {
    expect(validateSignupEmail('  Creator@Example.com  ')).toEqual({
      ok: true,
      email: 'creator@example.com',
    });
  });

  it('accepts a plain valid address unchanged in case form', () => {
    expect(validateSignupEmail('creator@example.com')).toEqual({
      ok: true,
      email: 'creator@example.com',
    });
  });

  it.each([
    ['non-string input', 42],
    ['null input', null],
    ['undefined input', undefined],
    ['a non-email string', 'not-an-email'],
    ['a whitespace-only string', '   '],
    ['an address with no domain', 'creator@'],
  ])('rejects %s', (_label, value) => {
    expect(validateSignupEmail(value)).toEqual({ ok: false });
  });
});
