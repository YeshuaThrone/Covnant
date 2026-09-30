/**
 * CVT Astra extraction agent — traversal vocabulary (PR 6).
 *
 * Astra is the browser-use lane of the Deep Royalties engine: it traverses
 * the dashboards the credential vault (PR 5) holds connections for,
 * downloads raw statements/logs/contracts, and lands every capture into
 * statement_ingests plus ONE royalty_recon_jobs enqueue per statement —
 * the existing enqueue path (Store.insertStatementIngest then
 * Store.createReconJob), never a parallel queue. The CVT recon worker
 * (PR 2) owns everything after the handoff: claim, parse, match.
 *
 * The secrecy contract this lane enforces by construction: vault
 * credentials are decrypted IN MEMORY per traversal, passed ONLY into the
 * session's fill seam, and scrubbed from every artifact, error message,
 * and vision-engine payload by exact-string redaction before
 * serialization. The no-credential-leak test pins all of it.
 *
 * Identifier capture duty (canon v11): code values are captured VERBATIM —
 * the raw statement bytes preserved in statement_ingests.content are the
 * capture surface. Pattern enforcement and validation are downstream
 * (migration 0012's DB trigger; the PR 52 engine). This lane never
 * validates, repairs, or normalizes a code — verbatim means verbatim.
 *
 * No Next.js imports: this file runs under tsx as a standalone process
 * (npm run worker:astra) and under Vitest against the in-memory store.
 */

import type { StatementFormat } from '@/modules/sdk/records';
import type {
  AstraVertical,
  DistributorConnectionSource,
} from '@/modules/vault/records';

/** The traversal's outcome — honest about the empty dashboard too. */
export type AstraTraversalOutcome = 'extracted' | 'no_statements' | 'failed';

/**
 * One raw statement (or log, or contract) the traversal downloaded. The
 * identifier duty's capture surface: global identifier codes (canon v11's
 * GlobalIdentifierType families) ride in `content` VERBATIM — Astra runs
 * no extraction, no canonicalization; ingestion-time validation and
 * pattern enforcement are the cross-code engine's downstream duty (PR 52,
 * migration 0012).
 */
export interface CapturedStatement {
  /** The dashboard's own file name for the download — never rewritten. */
  fileName: string;
  /** The download's raw content, preserved byte-verbatim. */
  content: string;
  /** The ingest format family — delimited text captures only this PR. */
  format: StatementFormat;
}

/**
 * One audit capture from the traversal. Content is REDACTED before it
 * lands here — the credential scrubber runs at capture-construction time,
 * so an artifact can never carry a credential value.
 */
export interface TraversalArtifact {
  /** What the capture shows — e.g. `login:distrokid`, `dashboard:netflix`. */
  label: string;
  kind: 'page_capture' | 'vision_request';
  /** The redacted page HTML (or the redacted vision-engine request body). */
  content: string;
}

/** The full record of one connection's traversal — the sweep's unit result. */
export interface AstraTraversalRecord {
  connectionId: string;
  holderId: string;
  distributor: DistributorConnectionSource | null;
  /** Set only when a registered adapter profile drove the traversal. */
  vertical: AstraVertical | null;
  outcome: AstraTraversalOutcome;
  statements: readonly CapturedStatement[];
  artifacts: readonly TraversalArtifact[];
  /** statement_ingests ids the handoff landed (parallel to jobIds). */
  ingestIds: readonly string[];
  /** royalty_recon_jobs ids enqueued (one per statement). */
  jobIds: readonly string[];
  /** The honest failure reason — redacted; null on success. */
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

/** The sweep's summary — what the loop logs (counts and ids only). */
export interface AstraSweepSummary {
  traversed: number;
  extracted: number;
  noStatements: number;
  failed: number;
  statementsCaptured: number;
  jobsEnqueued: number;
}
