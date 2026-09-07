/**
 * CBT · Covnant Banking & Tracker — deterministic settlement tracker codes.
 *
 * Canonical tier definition (Generation 8, user-locked): CBT is "the primary
 * outward-facing Covnant code attached to routing, banking, and royalty
 * tracking so external entities recognize it as Covnant clearing
 * infrastructure."
 *
 * Every code path that INSERTs into universal_royalty_ledger stamps the row's
 * metadata with a deterministic tracker code derived from its own
 * reference_id:
 *
 *     metadata.cbt = { settlementCode: 'CBT-SETTLE-<12 uppercase hex>',
 *                      derivedFrom: 'reference_id' }
 *
 * The ledger's UNIQUE reference_id index already guarantees one row per
 * event, so the same reference_id always yields the same code and a re-derived
 * code is a no-op — replay idempotency needs no new constraint and the ledger
 * stays append-only. The write is additive metadata only: it never touches
 * amount_cents, transaction_type, reference_id, or any persisted code format,
 * and the engine's minted asset codes remain the stored system of record.
 */

import { createHash } from 'node:crypto';

/** Every settlement code ever derived matches this shape. */
export const CBT_SETTLEMENT_CODE_PATTERN = /^CBT-SETTLE-[0-9A-F]{12}$/;

/** Same reference_id ⇒ same code, forever. Pure and deterministic. */
export function generateCBTSettlementCode(referenceId: string): string {
  const digest = createHash('sha256').update(referenceId, 'utf8').digest('hex');
  return `CBT-SETTLE-${digest.slice(0, 12).toUpperCase()}`;
}

export interface CbtSettlementTag {
  settlementCode: string;
  derivedFrom: 'reference_id';
}

/** The metadata object merged into every ledger row's metadata payload. */
export function cbtSettlementMetadata(referenceId: string): { cbt: CbtSettlementTag } {
  return { cbt: { settlementCode: generateCBTSettlementCode(referenceId), derivedFrom: 'reference_id' } };
}

/**
 * Merge-only stamp: every existing metadata key survives (PR #26 provenance
 * and the Generation 7 lineage object included) and the cbt tag is added.
 * Even if a cbt key were somehow already present, the value is deterministic
 * from the same reference_id, so the result is identical either way.
 */
export function withCbtSettlementCode(
  metadata: Record<string, unknown>,
  referenceId: string,
): Record<string, unknown> {
  return { ...metadata, ...cbtSettlementMetadata(referenceId) };
}

/**
 * The settlement tag as a SQL expression, for the banking INSERT paths whose
 * parameter lists are frozen by contract tests (exactly three bound params).
 * The inlined value is computed here from the row's own reference_id and is
 * charset-locked to [0-9A-F] by the generator — never user input — so the
 * interpolation is injection-safe by construction.
 */
export function cbtSettlementMetadataSql(referenceId: string): string {
  const code = generateCBTSettlementCode(referenceId);
  return `jsonb_build_object('cbt', jsonb_build_object('settlementCode', '${code}', 'derivedFrom', 'reference_id'))`;
}
