/**
 * Sign-in payload validation — the returning-creator mirror of the signup
 * contract's grammar. Same email rule, same message discipline: named
 * codes, brand-spelled copy. The password is deliberately NOT normalized
 * (a leading/trailing space is part of the secret) and is never echoed
 * back — validation results carry the trimmed email only.
 */

export type CovnantSigninErrorCode =
  | 'malformed_body'
  | 'missing_email'
  | 'invalid_email'
  | 'missing_password';

export type CovnantSigninValidationResult =
  | { ok: true; value: { email: string; password: string } }
  | { ok: false; code: CovnantSigninErrorCode; message: string };

const ERROR_MESSAGES: Record<CovnantSigninErrorCode, string> = {
  malformed_body: 'Request body must be a JSON object.',
  missing_email: 'email is required.',
  invalid_email: 'email must be a valid email address.',
  missing_password: 'password is required.',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(code: CovnantSigninErrorCode): CovnantSigninValidationResult {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

export function validateCovnantSigninPayload(
  input: unknown,
): CovnantSigninValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('malformed_body');
  }

  const { email, password } = input as { email?: unknown; password?: unknown };

  if (typeof email !== 'string' || email.trim() === '') {
    return fail('missing_email');
  }
  if (!EMAIL_RE.test(email.trim())) {
    return fail('invalid_email');
  }
  if (typeof password !== 'string' || password === '') {
    return fail('missing_password');
  }

  return {
    ok: true,
    value: { email: email.trim().toLowerCase(), password },
  };
}
