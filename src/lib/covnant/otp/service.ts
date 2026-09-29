/**
 * The phone OTP core — generation, hashing, comparison, expiry constants.
 *
 * Everything here is pure (no env reads, no I/O) so the routes and tests can
 * compose it freely. The one deliberate departure from the spec's sketch:
 * hashOtp takes the server secret as an explicit argument instead of reading
 * process.env itself — an env read inside a pure function would make the
 * hashing untestable and the missing-secret failure silent. The routes read
 * OTP_HASH_SECRET once and fail closed (503 otp_not_configured) before any
 * code exists.
 *
 * Locked decisions (spec art_pd8VlEMI):
 *   - 6-digit zero-padded codes from crypto.randomInt (no modulo bias).
 *   - HMAC-SHA256 over `userId:phone:code` keyed by OTP_HASH_SECRET — the
 *     plaintext code never touches the database.
 *   - Comparison is constant-time (timingSafeEqual) with a length guard so
 *     a corrupt stored hash degrades to "no match", never a thrown compare.
 *   - 5-minute TTL, max 5 attempts, 60-second resend cooldown — the TTL and
 *     cooldown are named here so the routes and the UI render one truth.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** How long a code stays verifiable. */
export const OTP_TTL_MINUTES = 5;

/** Invalid-entry attempts before the row is dead and a fresh code is required. */
export const OTP_MAX_ATTEMPTS = 5;

/** Server-enforced resend cooldown — a new code cannot be requested sooner. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** 6-digit, zero-padded — `randomInt` is rejection-sampled, no modulo bias. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * The at-rest form: HMAC-SHA256 over userId:phone:code, keyed by the server
 * secret. user_id and phone bind the digest to THIS profile and number — a
 * code intercepted for one account cannot be replayed as another's row.
 */
export function hashOtp(userId: string, phone: string, code: string, secret: string): string {
  return createHmac('sha256', secret).update(`${userId}:${phone}:${code}`).digest('hex');
}

/**
 * Constant-time digest comparison with a length guard: a corrupt or
 * shorter/longer stored hash fails closed (false) instead of throwing, so
 * the route's only observable outcome for a bad row is "wrong code".
 */
export function otpMatches(stored: string, computed: string): boolean {
  const storedBytes = Buffer.from(stored, 'hex');
  const computedBytes = Buffer.from(computed, 'hex');
  if (storedBytes.length === 0 || storedBytes.length !== computedBytes.length) {
    return false;
  }
  return timingSafeEqual(storedBytes, computedBytes);
}

/** The SMS body — the ONLY place the plaintext code is ever rendered. */
export function buildOtpMessage(code: string): string {
  return `Covnant: your verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`;
}
