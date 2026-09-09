/**
 * Signup payload validation — the drop's nine named codes, brand-spelled.
 *
 * Every field is trimmed and lowercased where meaningful; the password is
 * deliberately NOT normalized (a leading/trailing space is part of the
 * secret). The email rule is pattern-based; Supabase Auth enforces its own
 * deliverability and length limits downstream.
 */

import type { CovnantSignupInput } from '@/lib/covnant/types';

export type CovnantSignupErrorCode =
  | 'malformed_body'
  | 'missing_stage_name'
  | 'missing_legal_name'
  | 'invalid_email'
  | 'invalid_phone'
  | 'missing_core_industry'
  | 'missing_title'
  | 'invalid_password'
  | 'udr_terms_required';

export type CovnantSignupValidationResult =
  | { ok: true; value: CovnantSignupInput }
  | { ok: false; code: CovnantSignupErrorCode; message: string };

const ERROR_MESSAGES: Record<CovnantSignupErrorCode, string> = {
  malformed_body: 'Request body must be a JSON object.',
  missing_stage_name: 'stage_name is required.',
  missing_legal_name: 'legal_name is required.',
  invalid_email: 'email must be a valid email address.',
  invalid_phone: 'phone must be an E.164 number (for example +15125550123).',
  missing_core_industry: 'core_industry is required.',
  missing_title: 'title is required.',
  invalid_password: 'password must be a string of at least 8 characters.',
  udr_terms_required: 'udr_terms_accepted must be true.',
};

const E164_RE = /^\+[1-9]\d{1,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(code: CovnantSignupErrorCode): CovnantSignupValidationResult {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function normalizeOptionalE164(
  value: unknown,
): { ok: true; phone: string | null } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, phone: null };
  }
  if (typeof value !== 'string') {
    return { ok: false };
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return { ok: true, phone: null };
  }
  if (!E164_RE.test(trimmed)) {
    return { ok: false };
  }
  return { ok: true, phone: trimmed };
}

export function validateCovnantSignupPayload(
  input: unknown,
): CovnantSignupValidationResult {
  if (!isRecord(input)) {
    return fail('malformed_body');
  }

  if (!isNonEmptyString(input.stage_name)) {
    return fail('missing_stage_name');
  }
  if (!isNonEmptyString(input.legal_name)) {
    return fail('missing_legal_name');
  }
  if (!isNonEmptyString(input.email) || !EMAIL_RE.test(input.email.trim())) {
    return fail('invalid_email');
  }

  const phoneResult = normalizeOptionalE164(input.phone);
  if (!phoneResult.ok) {
    return fail('invalid_phone');
  }

  if (!isNonEmptyString(input.core_industry)) {
    return fail('missing_core_industry');
  }
  if (!isNonEmptyString(input.title)) {
    return fail('missing_title');
  }

  if (typeof input.password !== 'string' || input.password.length < 8) {
    return fail('invalid_password');
  }

  if (input.udr_terms_accepted !== true) {
    return fail('udr_terms_required');
  }

  return {
    ok: true,
    value: {
      stage_name: input.stage_name.trim(),
      legal_name: input.legal_name.trim(),
      email: input.email.trim().toLowerCase(),
      phone: phoneResult.phone,
      core_industry: input.core_industry.trim(),
      title: input.title.trim(),
      password: input.password,
      udr_terms_accepted: true,
    },
  };
}
