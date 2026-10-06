// Compensating tax entries — the unwind half of the withholding pipeline.
//
// The tax audit (note_c5ksDgVw #7/#6) found that money that flows OUT of the
// withholding pipeline (a reversal, or a failed split saga) never flows back
// out of the tax trail: creator_ytd_earnings and tax_escrow_ledger keep the
// phantom gross, so reversed runs keep counting toward 1099s. Both failure
// paths unwind through this module so they cannot drift apart.
//
// The invariant: every unwind composes with migration 0057's atomic
// accumulate — NEGATIVE deltas through the same incrementCreatorYtd code
// path the settlement used, never an absolute-total write — and posts one
// negative escrow row per escrow row being unwound, keyed to the same
// split_run_id (migration 0059) so a run's escrow trail nets to zero.

import type { Store } from "@/lib/server/store";
import type { CreatorYtdEarnings, TaxEscrowRecord } from "@/modules/don/records";
import type { VaultBucket } from "@/modules/don/constants";

export type EscrowUnwind = {
  /** The compensating (negated) escrow row that was inserted. */
  escrow: TaxEscrowRecord;
  /** The YTD row AFTER the negative accumulate. */
  ytd: CreatorYtdEarnings;
};

/**
 * Exact inverse of one applyWithholding settlement: negates the escrow row
 * into a compensating ledger entry and subtracts the same gross/withheld
 * cents from the stored YTD via the atomic accumulate. The row's 1099 flags
 * are zeroed — a correction entry does not itself cross a threshold — and
 * the TIN determination is copied from the row it corrects.
 */
export async function unwindEscrowRow(
  store: Store,
  escrow: TaxEscrowRecord,
  now: Date = new Date(),
): Promise<EscrowUnwind> {
  const compensating = await store.insertTaxEscrow({
    creator_id: escrow.creator_id,
    tax_year: escrow.tax_year,
    gross_cents: -escrow.gross_cents,
    withheld_cents: -escrow.withheld_cents,
    net_cents: -escrow.net_cents,
    tin_verified: escrow.tin_verified,
    w9_on_file: escrow.w9_on_file,
    requires_1099: 0,
    crossed_1099_threshold: 0,
    created_at: now.toISOString(),
    split_run_id: escrow.split_run_id ?? null,
  });
  const ytd = await store.incrementCreatorYtd({
    creator_id: escrow.creator_id,
    tax_year: escrow.tax_year,
    gross_delta_cents: -escrow.gross_cents,
    withheld_delta_cents: -escrow.withheld_cents,
    updated_at: now.toISOString(),
  });
  return { escrow: compensating, ytd };
}

/**
 * Unwinds every escrow row attributable to one split run — the reversal's
 * phantom-gross removal (audit #7). Rows predating migration 0059 carry a
 * null split_run_id, are not attributable, and are NOT unwound (no
 * backfill; the approved-plan split owns that decision).
 */
export async function unwindEscrowForRun(
  store: Store,
  splitRunId: string,
  now: Date = new Date(),
): Promise<EscrowUnwind[]> {
  const unwinds: EscrowUnwind[] = [];
  for (const row of await store.listTaxEscrowByRun(splitRunId)) {
    unwinds.push(await unwindEscrowRow(store, row, now));
  }
  return unwinds;
}

/**
 * A full three-bucket signed delta where only `bucket` moves — the input
 * shape applyVaultDelta requires (both call sites: the reversal clawback
 * and the failed-saga compensation).
 */
export function vaultBucketDelta(
  bucket: VaultBucket,
  amountCents: number,
): { available_balance: number; pending_balance: number; reserve_balance: number } {
  return {
    available_balance: bucket === "available" ? amountCents : 0,
    pending_balance: bucket === "pending" ? amountCents : 0,
    reserve_balance: bucket === "reserve" ? amountCents : 0,
  };
}
