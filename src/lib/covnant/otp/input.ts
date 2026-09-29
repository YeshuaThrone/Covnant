/**
 * Shared input normalization for the phone OTP routes (and the client step).
 *
 * The email rule is ONE definition for both OTP endpoints and the UI — the
 * same trim + lowercase + pattern normalization the signup validator applies
 * before persisting creator_profiles.email, so the OTP routes' lookup by
 * email always matches the stored row. The regex mirrors signupValidation's
 * module-private EMAIL_RE (kept private on purpose; duplicating a two-line
 * pattern beats widening that module's contract).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Canonical lookup form of a submitted email, or null when it cannot be one. */
export function normalizeOtpEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}
