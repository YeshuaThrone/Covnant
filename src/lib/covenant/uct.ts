/**
 * UCT — Universal Covnant Tag (the creator-root identity).
 *
 * Canonical tier definition (Generation 8, user-locked): UCT is "the
 * universal root identity that follows the creator everywhere; the ultimate
 * fallback that tracks and claims the creator's assets globally." The
 * expansion is Universal Covnant Tag — earlier materials said "Universal
 * Creator Tag"; the user's latest wording is canonical.
 *
 * The UCT is minted at signup and parents every asset, engine registration,
 * and ledger row a creator will ever touch. It embeds issuance facts only —
 * never mutable state — so once minted it never changes and is never
 * re-derived:
 *
 *   UCT-[JURISDICTION]-[YEAR]-[SERIAL]-[CHECKSUM]
 *   UCT-US-2026-9F3A7C21-K4
 *
 * - JURISDICTION: 2-char ISO 3166, captured at issuance, immutable
 *   thereafter (defaults to "US" until a KYC-backed flow exists).
 * - YEAR: 4-digit issuance year.
 * - SERIAL: 8 uppercase hex chars, crypto-random (32 bits) from
 *   crypto.randomBytes — the same entropy class as the engine's
 *   generateCVTAssetCode. Random over sequential: a sequential serial
 *   discloses platform size, is enumerable, and caps the platform; a random
 *   draw with a uniqueness check has no ceiling. Uniqueness is checked at
 *   mint with bounded retry (3 attempts, then fail-closed) by the caller.
 * - CHECKSUM: 2 chars [0-9A-Z], a deterministic function of the preceding
 *   fields (FNV-1a 32-bit rendered in base36 — the same dependency-free
 *   hash family the registry-key adapter uses). Integrity validation ONLY:
 *   not a secret, not an auth factor — identity verification uses
 *   email/OTP, never code fragments.
 *
 * Pure and synchronous: the only runtime dependency is node:crypto for the
 * serial draw.
 */

import { randomBytes } from 'node:crypto';

/** Every valid UCT ever minted by this module matches this shape. */
export const UCT_PATTERN = /^UCT-[A-Z]{2}-\d{4}-[0-9A-F]{8}-[0-9A-Z]{2}$/;

/** The accepted signup engines, mapped to the onboarding verticals. */
export const SIGNUP_ENGINES = [
  'music_recording',
  'publishing',
  'youtube_content_id',
  'digital_assets',
] as const;
export type SignupEngine = (typeof SIGNUP_ENGINES)[number];

/** Issuance jurisdiction until a KYC-backed geo flow exists (spec assumption). */
export const DEFAULT_UCT_JURISDICTION = 'US';

const JURISDICTION_PATTERN = /^[A-Za-z]{2}$/;
const SERIAL_HEX_BYTES = 4; // 32 bits → 8 hex chars
const CHECKSUM_BASE = 36 ** 2; // 2 base36 chars → 1296 buckets

/** FNV-1a (32-bit) — dependency-free, deterministic, stable across runtimes. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The 2-char integrity checksum over the UCT prefix
 * ("UCT-JURISDICTION-YEAR-SERIAL"): base36, zero-padded, [0-9A-Z]. A
 * deterministic function of the prefix — never a secret, never an auth
 * factor.
 */
export function uctChecksum(prefix: string): string {
  return (fnv1a32(prefix) % CHECKSUM_BASE).toString(36).toUpperCase().padStart(2, '0');
}

/** Builds the full UCT from its issuance facts. Pure — same inputs, same code. */
export function buildUct(jurisdiction: string, year: number, serial: string): string {
  const prefix = `UCT-${jurisdiction}-${year}-${serial}`;
  return `${prefix}-${uctChecksum(prefix)}`;
}

/** A crypto-random 8-hex serial (32 bits) drawn from crypto.randomBytes. */
export function uctSerial(): string {
  return randomBytes(SERIAL_HEX_BYTES).toString('hex').toUpperCase();
}

/** The current issuance year (UTC — issuance facts never drift on timezone). */
export function uctIssuanceYear(now: Date = new Date()): number {
  return now.getUTCFullYear();
}

/**
 * Normalizes a jurisdiction to its 2-char uppercase ISO 3166 form; null when
 * the input is not a 2-letter code (the sanitized-400 case — the value is
 * never echoed back).
 */
export function normalizeJurisdiction(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return JURISDICTION_PATTERN.test(code) ? code : null;
}

/**
 * Normalizes a candidate signup engine to its canonical value; null when the
 * input is not one of the accepted engines. Absent engines are the caller's
 * concern (PR #27 compatibility) — this validates PRESENT values only.
 */
export function normalizeEngine(raw: unknown): SignupEngine | null {
  if (typeof raw !== 'string') return null;
  return (SIGNUP_ENGINES as readonly string[]).includes(raw) ? (raw as SignupEngine) : null;
}

/**
 * Integrity validation: the value must match the UCT shape AND carry a
 * checksum that recomputes exactly from its own prefix. A tampered serial,
 * jurisdiction, or year fails here even when the shape still matches.
 */
export function isValidUct(value: unknown): boolean {
  if (typeof value !== 'string' || !UCT_PATTERN.test(value)) return false;
  const prefix = value.slice(0, -'XX'.length - 1); // everything before "-<checksum>"
  return uctChecksum(prefix) === value.slice(-2);
}
