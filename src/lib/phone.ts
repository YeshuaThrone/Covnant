/**
 * Shared phone normalization — ONE implementation for every surface that
 * captures a phone number (signup form, Don KYC identity). Accepts any
 * real-world capture and returns canonical E.164, or null when the input
 * cannot be a real number.
 *
 * Any punctuation is allowed between digits (spaces, dashes, dots,
 * parentheses); at most ONE leading '+' is structural, every other
 * non-digit is stripped.
 *
 *   leading '+' + 8–15 digits → '+' + digits (true E.164 lengths, as typed)
 *   exactly 10 digits → '+1' + digits (US default — the product's
 *     jurisdictions are US-anchored)
 *   exactly 11 digits starting '1' → '+' + digits (US with the trunk digit)
 *
 * Extensions ('ext 5'), letters, and too-short/too-long digit runs have no
 * canonical reading → null (the caller rejects — never a silent drop).
 */
export function normalizePhoneInput(raw: string): string | null {
  const structuralPlus = raw.trimStart().startsWith('+');
  const digits = raw.replace(/[^0-9]/g, '');
  if (structuralPlus) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return null;
}
