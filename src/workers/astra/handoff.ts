/**
 * CVT Astra extraction agent — recon handoff (PR 6).
 *
 * The only exit for a captured statement: land the raw bytes verbatim into
 * statement_ingests (Store.insertStatementIngest), then enqueue exactly ONE
 * royalty_recon_jobs row for it (Store.createReconJob) with the ingest's id
 * as provenance and the rights holder as the requester. This is the same
 * enqueue path the UCT route uses — Astra adds no parallel queue, no
 * direct match_queue writes, and no parsing: the CVT recon worker (PR 2)
 * owns everything after this handoff.
 *
 * Status semantics on the ingest row: the vocabulary is 'parsed' | 'failed'
 * (migration 0007 — "the parse outcome"). Astra's capture runs no parse —
 * line-item parsing is the recon worker's claim step — so a clean capture
 * lands as status 'parsed' with event_count null and error null (nothing
 * was counted, nothing failed), and a capture that fails to download lands
 * as status 'failed' with the redacted reason, content still preserved
 * verbatim. The row's purpose here is provenance: original bytes either
 * way.
 *
 * Verbatim vs. secrecy, resolved: the verbatim duty covers IDENTIFIER
 * CODES, and the scrubber replaces only exact credential strings — values
 * that never belong in a statement. The content still passes through the
 * redaction gate before the store write so a dashboard echoing a filled
 * value into a download can never persist it. The no-credential-leak test
 * pins this lane too.
 */

import type { Store } from '@/lib/server/store';
import type { CapturedStatement } from './records';
import { redactCredentials, redactError } from './credentials';

export interface HandoffRecord {
  ingestId: string;
  jobId: string;
}

/** The redacted reason recorded when a capture fails. */
export function captureFailureReason(error: unknown, secrets: readonly string[]): string {
  return `capture_failed: ${redactError(error, secrets)}`;
}

/**
 * Land one captured statement and enqueue its recon job. Two store calls,
 * in order, using the ingest id the store minted — no batching wrapper, so
 * a partial failure leaves at most an ingest row without a job (recovery:
 * re-traversal re-lands and re-enqueues; the recon worker is idempotent by
 * ingest provenance).
 */
export async function handOffStatement(
  store: Store,
  statement: CapturedStatement,
  requestedBy: string | null,
  secrets: readonly string[],
  now: () => string = () => new Date().toISOString(),
): Promise<HandoffRecord> {
  const ingest = await store.insertStatementIngest({
    format: statement.format,
    source: 'statement',
    file_name: statement.fileName,
    content: redactCredentials(statement.content, secrets),
    status: 'parsed',
    event_count: null, // no parse ran — counting is the recon worker's step
    error: null,
    created_at: now(),
  });
  const job = await store.createReconJob({
    source: 'statement',
    ingest_id: ingest.id,
    requested_by: requestedBy,
  });
  return { ingestId: ingest.id, jobId: job.id };
}
