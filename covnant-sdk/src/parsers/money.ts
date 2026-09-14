/**
 * Exact decimal-string → micros conversion for statement money cells.
 *
 * Statement formats carry amounts as decimal strings ("1152.24", "0.0905")
 * with sender-chosen precision (RDR-R 6.4.9 does not prescribe a precision).
 * Floats never enter the SDK's money path (the fixed-point discipline of
 * src/lib/fixed-point.ts), so this module converts the string EXACTLY with
 * bigint arithmetic: the whole number of 1e-8 micros is computed from the
 * digits, never from a floating-point value.
 *
 * Deliberately strict — a value is either converted losslessly or rejected:
 *
 * - digits with at most 8 decimal places ("1176153.65", "0.0905", "12");
 * - NO thousands separators, NO currency symbols, NO leading/trailing
 *   spaces (senders padding cells with spaces fail the check — RDR-R 6.4.3.5
 *   forbids space around delimiters anyway);
 * - NO signs: a canonical event's gross is non-negative, so "-52.24" is not
 *   an amount this module converts (deduction cells carry negatives, and the
 *   parsers that consume gross cells reject them with a dedicated reason).
 */

/** The maximum decimal precision the 1e-8 micros space can represent. */
const MICROS_DECIMALS = 8;

/** Multiplier from a currency unit to micros, as a bigint power of ten. */
const MICROS_PER_UNIT = BigInt(10) ** BigInt(MICROS_DECIMALS);

/** Whole decimal amounts with at most eight fractional digits — nothing else. */
const DECIMAL_PATTERN = new RegExp(`^\\d+(\\.\\d{1,${MICROS_DECIMALS}})?$`);

export type DecimalAmount =
  | { ok: true; micros: bigint }
  | { ok: false; reason: 'negative' | 'invalid' };

/**
 * Converts one decimal amount string into 1e-8 micros, exactly. Returns a
 * stable rejection reason for a negative value and for anything that is not
 * a plain decimal string — never a guessed coercion.
 */
export function decimalToMicros(value: string): DecimalAmount {
  if (value.startsWith('-')) return { ok: false, reason: 'negative' };
  if (!DECIMAL_PATTERN.test(value)) return { ok: false, reason: 'invalid' };

  const pointIndex = value.indexOf('.');
  const integerPart = pointIndex === -1 ? value : value.slice(0, pointIndex);
  const fractionPart = pointIndex === -1 ? '' : value.slice(pointIndex + 1);
  const fractionMicros = BigInt(fractionPart.padEnd(MICROS_DECIMALS, '0'));

  return {
    ok: true,
    micros: BigInt(integerPart) * MICROS_PER_UNIT + fractionMicros,
  };
}
