/**
 * Engine-boundary CBT stamping (Generation 9).
 *
 * The vendored SDK's ledger upsert (processUniversalSocialWebhookAction) is
 * hash-locked and writes flat-schema rows without metadata, so the repo-side
 * caller enriches each freshly upserted row AFTER the SDK write completes: a
 * metadata-only read-merge-update keyed by the row's transaction_id. The
 * enrichment never touches amount, status, or any money field — the ledger
 * stays append-only in the row sense, the same rule the Generation 7 lineage
 * lane follows — and every failure path skips the code while the settled
 * money stands (the same money-never-blocks rule the Generation 8 raw-SQL
 * 42703 fallback follows).
 */

import { supabaseFromEnv } from '../supabase';
import { isMissingMetadataColumnError, METADATA_COLUMN_DDL_NOTE, withCbtSettlementCode } from './cbt-settlement';

export interface EngineStampSummary {
  /** Rows whose metadata.cbt was written (metadata column present and writable). */
  stamped: number;
  /** Rows left untouched because a read/merge/update step failed — the settled row stands. */
  skipped: number;
}

/**
 * Enrich settled engine rows with the deterministic CBT settlement code,
 * derived from each row's transaction_id — the flat schema's unique row
 * reference; the tag literal stays the frozen Generation 8 shape. Bounded:
 * one read-merge-update per referenced row, metadata column only. Never
 * throws — an enrichment failure warns and skips, so the settlement never
 * blocks on provenance.
 */
export async function stampEngineLedgerRowsCbt(
  transactionIds: readonly string[],
  db: ReturnType<typeof supabaseFromEnv> = supabaseFromEnv(),
): Promise<EngineStampSummary> {
  if (!db || transactionIds.length === 0) return { stamped: 0, skipped: 0 };
  const summary: EngineStampSummary = { stamped: 0, skipped: 0 };

  for (const transactionId of transactionIds) {
    try {
      const { data, error: readError } = await db
        .from('universal_royalty_ledger')
        .select('metadata')
        .eq('transaction_id', transactionId)
        .maybeSingle();

      if (readError || !data) {
        summary.skipped += 1;
        console.warn(
          `universal_royalty_ledger.metadata read failed for ${transactionId} — the row keeps its settled state without the CBT stamp.` +
            (readError ? ` ${readError.message}` : ''),
        );
        if (readError && isMissingMetadataColumnError(readError)) {
          console.warn(METADATA_COLUMN_DDL_NOTE);
        }
        continue;
      }

      // Merge-only: every metadata key the row already carries survives; the
      // deterministic cbt tag is added. The update addresses ONLY the
      // metadata column — no amount, status, or money field is writable here.
      const metadata = withCbtSettlementCode(
        ((data as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>,
        transactionId,
      );
      const { error: updateError } = await db
        .from('universal_royalty_ledger')
        .update({ metadata })
        .eq('transaction_id', transactionId);

      if (updateError) {
        summary.skipped += 1;
        console.warn(
          `universal_royalty_ledger.metadata enrichment failed for ${transactionId} — the row keeps its settled state without the CBT stamp. ${updateError.message}`,
        );
        if (isMissingMetadataColumnError(updateError)) console.warn(METADATA_COLUMN_DDL_NOTE);
        continue;
      }
      summary.stamped += 1;
    } catch (error) {
      summary.skipped += 1;
      console.warn(
        `universal_royalty_ledger.metadata enrichment threw for ${transactionId} — the row keeps its settled state without the CBT stamp.`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return summary;
}
