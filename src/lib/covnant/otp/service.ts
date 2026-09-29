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

/**
 * The rotating OTP message set — deliverability engineering, full stop.
 * Carriers and anti-spam pipelines are far more likely to throttle or junk
 * filter a body that looks identical on every send; rotating a small set of
 * compliant bodies (plain language, no spammy punctuation, same truthful
 * expiry) keeps delivery healthy at Textbee/WhatsApp scale. Rotation changes
 * NOTHING else: same code, same cooldown, same attempt semantics.
 */
export const OTP_MESSAGE_TEMPLATES: readonly string[] = [
  'Covnant: your verification code is {code}. It expires in {minutes} minutes.',
  'Your Covnant verification code is {code}. The code expires in {minutes} minutes.',
  'Covnant verification: {code}. This code expires in {minutes} minutes.',
] as const;

/**
 * Pure renderer for a template index — the deterministic core the rotation
 * tests pin. Index wraps modulo the template count, so any non-negative
 * index renders a valid body.
 */
export function renderOtpMessage(templateIndex: number, code: string): string {
  const template = OTP_MESSAGE_TEMPLATES[templateIndex % OTP_MESSAGE_TEMPLATES.length] ?? '';
  return template.replaceAll('{code}', code).replaceAll('{minutes}', String(OTP_TTL_MINUTES));
}

/** Module-level rotation cursor — advances once per rendered message. */
let messageRotation = 0;

export function nextOtpMessageIndex(): number {
  const index = messageRotation % OTP_MESSAGE_TEMPLATES.length;
  messageRotation += 1;
  return index;
}

/** The SMS body for a request — the ONLY place the plaintext code is ever rendered. */
export function buildOtpMessage(code: string): string {
  return renderOtpMessage(nextOtpMessageIndex(), code);
}
