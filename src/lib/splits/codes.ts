/**
 * Code identity for the platform (spec §Locked 5): the engine's
 * `CBT-<PREFIX>-<12-hex>` code is canonical and stored everywhere; the UI
 * additionally renders a `CVT-<PREFIX>-XXXX` display badge derived from the
 * canonical code (last four hex of the code body).
 */
export function cvtDisplayCode(cbtCode: string): string {
  const match = /^CBT-([A-Z]+)-([0-9A-F]{12})$/.exec(cbtCode.toUpperCase());
  if (!match) return cbtCode.toUpperCase();
  return `CVT-${match[1]}-${match[2].slice(-4)}`;
}
