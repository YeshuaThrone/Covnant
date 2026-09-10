/**
 * Money formatting for the creator dashboard — the display edge of the
 * ledger's BigInt smallest-unit strings (1e-8 scale, the numeric(20,8)
 * columns). Pure string/BigInt math: never a float, never a rollup across
 * currencies — each line carries its own currency code.
 *
 * The card copy mirrors the bank reference's plain-money voice:
 *   - formatUnitsMajor:  the primary figure   → "12.50 USD"
 *   - formatUnitsMinor:  the exact ledger sum → "1,234.56789101 USD"
 *   - formatUnitsSigned: a withheld/outflow   → "−0.37 USD"
 */

/** A BigInt smallest-unit string from the ledger (may carry a +/− sign). */
export type UnitsString = string;

/** The ledger's fixed scale: 10^8, matching numeric(20,8) columns. */
const SCALE = 100_000_000n;

function splitUnits(units: UnitsString): { negative: boolean; whole: bigint; frac: bigint } {
  const negative = units.startsWith('-');
  const magnitude = BigInt(negative ? units.slice(1) : units);
  const whole = magnitude / SCALE;
  const frac = magnitude % SCALE;
  return { negative, whole, frac };
}

/** The ledger's 8 fractional digits — exact, UNGROUPED (grouping the
 * fraction misreads as thousands: "1.750,000,00" looks like 1.75M). */
function fractionalDigits(frac: bigint): string {
  return frac.toString().padStart(8, '0');
}

/**
 * The primary figure — whole units + two decimals, thousands-grouped.
 * ("12,345.67 USD") Truncation-only beyond the first two decimals: a
 * display figure never rounds money up.
 */
export function formatUnitsMajor(units: UnitsString, currency: string): string {
  const { negative, whole, frac } = splitUnits(units);
  const wholeGrouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const leadingDecimals = frac.toString().padStart(8, '0').slice(0, 2);
  return `${negative ? '−' : ''}${wholeGrouped}.${leadingDecimals} ${currency}`;
}

/** The exact ledger figure — every significant digit, thousands-grouped. */
export function formatUnitsMinor(units: UnitsString, currency: string): string {
  const { negative, whole, frac } = splitUnits(units);
  const wholeGrouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${wholeGrouped}.${fractionalDigits(frac)} ${currency}`;
}

/** A signed figure (withheld / outflow) — the minus is a true minus sign. */
export function formatUnitsSigned(units: UnitsString, currency: string): string {
  return formatUnitsMajor(units, currency);
}
