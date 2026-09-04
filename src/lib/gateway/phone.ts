/**
 * Gateway phone normalization.
 *
 * The CovnantSDK gateway collects a NANP number (the UI renders a fixed +1
 * country-code prefix) and Supabase requires strict E.164 for SMS OTP
 * (`signInWithOtp({ phone })`), so every handler normalizes to +1 plus the
 * digits-only local number before calling auth.
 */

/** Strict-enough E.164 shape: +, nonzero country code, 8–14 subscriber digits. */
export const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

/** digits-only NANP local number -> E.164 with the gateway's fixed +1 prefix. */
export function toE164Phone(rawLocalNumber: string): string {
  return `+1${rawLocalNumber.replace(/\D/g, '')}`;
}
