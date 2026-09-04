/**
 * Fixed-point money and split handler — every display and adapter calculation
 * runs on BigInt integers, never on floats.
 *
 * Two integer spaces live here:
 *
 * - MICRO — currency at 8 decimal places (1 unit = 10⁻⁸). Ledger amounts,
 *   fees, corner dust, and disbursements reconcile and render in this space.
 * - PERCENT — splits at 4 decimal places of a percent (1 unit = 0.0001%).
 *   This is exactly the vendored engine's convention: a percentage `p` maps
 *   to `p × 10,000` units, so 100% is 1,000,000 units.
 *
 * Floats cross the boundary only through four documented adapters
 * (microFromNumber, microToNumber, percentNumberToUnits, percentUnitsToNumber)
 * that convert via the value's exact decimal string — never through
 * `value * scale`, whose binary rounding is the bug class this module exists
 * to eliminate.
 */

export const MICRO_DECIMALS = 8;
/** 10⁸ micro units per currency unit. */
export const MICRO_SCALE = 100_000_000n;

export const PERCENT_DECIMALS = 4;
/** 10⁴ percent units per percent — the engine's split scale. */
export const PERCENT_SCALE = 10_000n;

/** Thrown for input a strict parser must not silently coerce (wrong shape or excess precision). */
export class FixedPointParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixedPointParseError';
  }
}

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Parse a plain decimal string into integer units at `scaleDigits` decimal
 * places. Strict by design: no separators, no exponent form, and no more
 * than `scaleDigits` fractional digits — lossy input must fail loudly, not
 * round silently.
 */
function parseToUnits(raw: string, scaleDigits: number, label: string): bigint {
  const value = raw.trim();
  if (!DECIMAL_PATTERN.test(value)) {
    throw new FixedPointParseError(`${label}: "${raw}" is not a plain decimal number.`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf('.');
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  if (fracPart.length > scaleDigits) {
    throw new FixedPointParseError(
      `${label}: "${raw}" carries more than ${scaleDigits} decimal places.`,
    );
  }
  const units = BigInt(intPart + fracPart.padEnd(scaleDigits, '0'));
  return negative ? -units : units;
}

/** Half-up integer division for non-negative operands (display rounding). */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function formatUnitsWithScale(units: bigint, scaleDigits: number, decimals: number): string {
  if (decimals < 0 || decimals > scaleDigits) {
    throw new RangeError(`decimals must be between 0 and ${scaleDigits}.`);
  }
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const scale = 10n ** BigInt(scaleDigits);
  const shift = 10n ** BigInt(scaleDigits - decimals);
  const rounded = decimals === scaleDigits ? magnitude : divRoundHalfUp(magnitude, shift);
  const whole = rounded / (scale / shift);
  const frac = rounded % (scale / shift);
  const fracStr = frac.toString().padStart(decimals, '0');
  const rendered = decimals === 0 ? whole.toString() : `${whole}.${fracStr}`;
  return negative && rounded !== 0n ? `-${rendered}` : rendered;
}

// ---------------------------------------------------------------------------
// MICRO — currency at 8 decimal places
// ---------------------------------------------------------------------------

/** Parse a strict decimal string ("1234.56789012") into micro units. */
export function parseMicro(value: string): bigint {
  return parseToUnits(value, MICRO_DECIMALS, 'Micro amount');
}

/** Non-throwing parseMicro for form state — null when the input is not exact at 8 dp. */
export function tryParseMicro(value: string): bigint | null {
  try {
    return parseMicro(value);
  } catch (error) {
    if (error instanceof FixedPointParseError) return null;
    throw error;
  }
}

/** Format micro units as a decimal string, rounding half-up to `decimals` places. */
export function formatMicro(units: bigint, decimals: number = MICRO_DECIMALS): string {
  return formatUnitsWithScale(units, MICRO_DECIMALS, decimals);
}

/** Sum micro amounts without drift. */
export function addMicro(...values: bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n);
}

/** Subtract micro amounts without drift. */
export function subMicro(a: bigint, b: bigint): bigint {
  return a - b;
}

/**
 * Allocate `total` across weights with zero dust loss: the parts always
 * recombine to exactly `total` (largest-remainder method, ties broken by
 * index). Royalty amounts are non-negative; negative totals are rejected.
 */
export function allocateMicro(total: bigint, weights: bigint[]): bigint[] {
  return allocateByWeights(total, weights);
}

function allocateByWeights(total: bigint, weights: bigint[]): bigint[] {
  if (total < 0n) throw new RangeError('Allocation total must be non-negative.');
  if (weights.length === 0) throw new RangeError('Allocation requires at least one weight.');
  if (weights.some((w) => w < 0n)) throw new RangeError('Allocation weights must be non-negative.');
  const weightSum = weights.reduce((acc, w) => acc + w, 0n);
  if (weightSum === 0n) throw new RangeError('Allocation weights must not all be zero.');

  const parts = weights.map((w) => (total * w) / weightSum);
  const residuals = weights.map((w) => (total * w) % weightSum);
  const dust = total - parts.reduce((acc, p) => acc + p, 0n);

  const order = residuals
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (b.remainder !== a.remainder ? (b.remainder > a.remainder ? 1 : -1) : a.index - b.index));
  let remaining = dust;
  for (const { index } of order) {
    if (remaining === 0n) break;
    parts[index] += 1n;
    remaining -= 1n;
  }
  return parts;
}

/**
 * Boundary adapter — ledger/DB/engine amounts arrive as JS numbers. Serializes
 * the double to its exact 8-dp decimal rendering and parses it as micro units
 * (rounding half-up at the eighth decimal). This is the ONLY place a currency
 * number enters integer space.
 */
export function microFromNumber(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new FixedPointParseError(`Micro amount: ${value} is not finite.`);
  }
  if (Math.abs(value) >= Number.MAX_SAFE_INTEGER) {
    throw new FixedPointParseError(`Micro amount: ${value} exceeds the safe integer range.`);
  }
  return parseMicro(value.toFixed(MICRO_DECIMALS));
}

/**
 * Boundary adapter — the engine's settlement actions take `number` amounts.
 * Micro units up to 2⁵³ are exact integers, so this conversion is lossless
 * for any realistic royalty amount.
 */
export function microToNumber(units: bigint): number {
  return Number(units) / Number(MICRO_SCALE);
}

// ---------------------------------------------------------------------------
// PERCENT — splits at 4 decimal places (the engine's unit space)
// ---------------------------------------------------------------------------

/** Parse a strict 4-dp percent string ("33.3333") into engine percent units. */
export function parsePercentUnits(value: string): bigint {
  return parseToUnits(value, PERCENT_DECIMALS, 'Split percent');
}

/** Non-throwing parsePercentUnits for form state. */
export function tryParsePercentUnits(value: string): bigint | null {
  try {
    return parsePercentUnits(value);
  } catch (error) {
    if (error instanceof FixedPointParseError) return null;
    throw error;
  }
}

/** Format engine percent units as a fixed 4-dp percent string, e.g. 999_999n → "99.9999". */
export function formatPercentUnits(units: bigint): string {
  return formatUnitsWithScale(units, PERCENT_DECIMALS, PERCENT_DECIMALS);
}

/**
 * Boundary adapter — engine holders carry `splitPercentage` as a JS number at
 * 4-dp percent granularity. Converts through the value's 4-dp decimal string
 * (never `pct * scale`), so 33.3333 maps to exactly 333_333 units.
 */
export function percentNumberToUnits(pct: number): bigint {
  if (!Number.isFinite(pct)) {
    throw new FixedPointParseError(`Split percent: ${pct} is not finite.`);
  }
  return parseToUnits(pct.toFixed(PERCENT_DECIMALS), PERCENT_DECIMALS, 'Split percent');
}

/** Boundary adapter — percent units back to the engine's number convention. */
export function percentUnitsToNumber(units: bigint): number {
  return Number(units) / Number(PERCENT_SCALE);
}

/** Format a percent VALUE (not units) at 4 dp: 33.3333 → "33.3333". */
export function formatPercentValue(pct: number): string {
  return formatPercentUnits(percentNumberToUnits(pct));
}

/**
 * Render a withholding-rate fraction as a percent string: 0.1 → "10.00".
 * Parsed at micro precision (8 dp), converted to percent units (×100) with
 * half-up rounding, then displayed at `decimals` places.
 */
export function formatFractionAsPercent(fraction: number, decimals = 2): string {
  const micro = microFromNumber(fraction);
  const percentUnits = divRoundHalfUp(micro, 100n);
  return formatUnitsWithScale(percentUnits, PERCENT_DECIMALS, decimals);
}
