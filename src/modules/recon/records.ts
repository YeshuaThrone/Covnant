/**
 * Deep Royalties recon engine — record vocabulary for the durable
 * royalty_recon_jobs queue (migration 0011, spec art_7M0snhxc). snake_case
 * fields match the database columns 1:1 (the Store seam convention — records
 * are the rows). Types are re-exported through the Store seam
 * (src/lib/server/store.ts); the CVT worker (PR 2) and the UCT routes (PR 1)
 * consume them and never touch store files.
 *
 * Topology note (the three-layer contract): a recon job is the UCT layer's
 * ONE write — the enqueue route inserts a row and returns 202; every heavy
 * step (claim, parse, match) belongs to the CVT worker lane, which resolves
 * jobs through claimReconJob/completeReconJob/failReconJob. Orchestration
 * lives here; parsed line items live in the EXISTING match_queue
 * (migration 0007) — never a parallel table.
 */

import type { StatementSource } from '@/modules/sdk/records';

/** Recon job lifecycle (migration 0011 check constraint). */
export type RoyaltyReconJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * The recon job's source — the statement_ingests.source vocabulary
 * (StatementSource, migration 0007), reused verbatim so a job and the
 * ingest it may reference can never disagree about what "source" means.
 * The build brief aligns this enum with the store code's usage; the column
 * is text, so extending the vocabulary is config-level, not DDL.
 */
export type ReconJobSource = StatementSource;

/** Runtime form of ReconJobSource — the zod enum in validation.ts consumes this. */
export const RECON_JOB_SOURCES = ['statement', 'manual'] as const;

/** Terminal statuses — a callback or completion for one of these is a replay. */
export const TERMINAL_RECON_JOB_STATUSES: readonly RoyaltyReconJobStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

/** True when the job has reached a state a completion report can no longer move. */
export function isTerminalReconJob(job: RoyaltyReconJobRecord): boolean {
  return TERMINAL_RECON_JOB_STATUSES.includes(job.status);
}

/**
 * The claim/parse outcome summary the worker writes on completion
 * (spec: { events_written, matched, unmatched, engine_used }).
 */
export interface ReconJobResult {
  /** match_queue rows written by the worker's parse pass. */
  events_written?: number;
  /** Rows cross-referenced to a cbt_assets identifier (matched_cbt_code set). */
  matched?: number;
  /** Rows quarantined without a CBT match — resolvable, never dropped. */
  unmatched?: number;
  /** The engine that produced the parse; null = deterministic code only. */
  engine_used?: string | null;
  /** Matched MUSIC lines credited to UNCLAIMED_HOLDING (the activated
   * canonical posting seam — integer cents, per-source replay guard). */
  holding_posted?: number;
  /** Matched lines whose post hit the per-source replay guard (409) —
   * counted no-ops, never double posts. */
  holding_replayed?: number;
  /** Podcast lane (PR 10): qualified impressions written as countable
   * `podcast:imp:` rows (plus Channel C subscription rows). */
  podcast_written?: number;
  /** Podcast lane: same-impression replays caught by the event-id guard. */
  podcast_replayed?: number;
  /** Podcast lane: sponsor-unverified host reads parked in `podcast:held:`
   * quarantine — visible, never counted, never posted. */
  podcast_held?: number;
  /** Podcast lane: IAB rejections — bot-filtered lines. */
  podcast_bots_filtered?: number;
  /** Podcast lane: IAB rejections — duplicate downloads inside the
   * 24-hour single-IP window. */
  podcast_duplicates_deduped?: number;
  /** Podcast lane: IAB rejections — audio requests under 60 seconds. */
  podcast_short_requests_rejected?: number;
  /** Podcast lane: commission deducted across the pass's posts, exact
   * fixed-point micros as text (never a float). */
  podcast_commission_micros?: string;
}

/** Input for Store.createReconJob — the enqueue route's one store call. */
export interface ReconJobInput {
  source: ReconJobSource;
  /** statement_ingests provenance the worker should re-parse, if any. */
  ingest_id?: string | null;
  /**
   * The requesting creator's registry rightsHolderId (the Don store's
   * creator key); null = operator job (migration 0011's column comment).
   */
  requested_by?: string | null;
}

/**
 * One durable recon job — orchestration only. The parsed line items live in
 * match_queue; this row carries the lifecycle, the claim state, and the
 * honest outcome summary.
 */
export interface RoyaltyReconJobRecord {
  id: string;
  status: RoyaltyReconJobStatus;
  source: ReconJobSource;
  ingest_id: string | null;
  requested_by: string | null;
  /** Resolved at claim; null = deterministic parse only (no model tokens). */
  engine: string | null;
  /** Incremented on every claim; the retry budget is attempts < 3. */
  attempts: number;
  /** The most recent failure reason — honest, even while retrying. */
  error: string | null;
  result: ReconJobResult | null;
  claimed_at: string | null;
  /** First-claim provenance — never reset by stale-claim recovery. */
  started_at: string | null;
  /** Set on the terminal transition (completed or failed). */
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
