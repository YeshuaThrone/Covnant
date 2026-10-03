/**
 * Unmatched-code fallback — UNCLAIMED_IDENTIFIER_HOLD trigger detection
 * (canon v1 outcome, refined through v22: line items missing mandatory
 * cross-links route to UNCLAIMED_IDENTIFIER_HOLD).
 *
 * SCOPE (locked in the task description): hold trigger DETECTION lives
 * here; escrow posting and registry verification are PR 53 scope — this
 * module never posts escrow and never pings a registry. It answers one
 * question purely and synchronously: does this ingested record lack the
 * cross-links that make it claimable?
 *
 * The v1 chains (music ISRC→ISWC→IPI→ISNI→MWLI, sports NIL→GLAN→PAID→NCAA
 * →GLN, film EIDR→ISAN→Ad-ID→CAMA) define the families' mandatory links;
 * per-family chain maps arrive with the PR 53 registry-ping flow. The
 * trigger rule here is the canon floor: a record whose crossReferences is
 * absent or empty has NO cross-links — it routes to the hold. The PR 53
 * release flow reads the cross_ref table's verification_source and
 * verified_at evidence columns to clear holds; a verified cross-link row
 * is the release precondition.
 */

import type { IdentityIngestionPayload } from './globalIdentifiers';

export type IdentifierHoldReason = 'UNCLAIMED_IDENTIFIER_HOLD';

export interface IdentifierHold {
  /** Position of the record in the submitted batch (v13/v20 index convention). */
  index: number;
  holdReason: IdentifierHoldReason;
  /** Human-readable detail — carried into logs and the recon event payload. */
  detail: string;
}

/**
 * Detect the records in a batch that must route to UNCLAIMED_IDENTIFIER_HOLD.
 * Pure and total: malformed records are the syntax gate's business (422
 * upstream), not this function's — it only inspects cross-link presence.
 */
export function detectIdentifierHolds(
  records: IdentityIngestionPayload[],
): IdentifierHold[] {
  const holds: IdentifierHold[] = [];
  records.forEach((record, index) => {
    const crossLinks = record.crossReferences ?? [];
    if (crossLinks.length === 0) {
      holds.push({
        index,
        holdReason: 'UNCLAIMED_IDENTIFIER_HOLD',
        detail: `Primary code ${record.primaryCodeType}:${record.primaryCodeValue} has no cross-links; mandatory cross-links missing — routed to UNCLAIMED_IDENTIFIER_HOLD.`,
      });
    }
  });
  return holds;
}
