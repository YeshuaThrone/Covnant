/**
 * Universal Royalty Collection SDK — record vocabulary for the collection
 * surfaces (migration 0007, PR 3 of Generation 16). snake_case fields match
 * the database columns 1:1 (the Store seam convention — records are the
 * rows). These types are re-exported through the Store seam
 * (src/lib/server/store.ts); SDK PRs 4+ (clearance, matcher, parsers)
 * consume them and never touch store files.
 *
 * MUL = Multi-Use License (the master-use license register). CBT = the
 * canonical catalog asset code (CVT/CBT lineage, project overview). Fixed
 * money stays text micros — never floats (immutability rule).
 */

/** The four canonical rights pipelines (build spec art_MzwqTXym). */
export type RightsPipeline =
  | 'composition_performance'
  | 'composition_mechanical'
  | 'master_digital_performance'
  | 'master_interactive';

/** Statement file formats the ingest provenance records can hold. */
export type StatementFormat = 'cwr' | 'ddex' | 'csv_statement';

/** Where an ingest's bytes came from. */
export type StatementSource = 'statement' | 'manual';

/** Parse outcome for one ingested statement file. */
export type StatementIngestStatus = 'parsed' | 'failed';

/** Match-queue lifecycle: quarantined → matched | discarded. */
export type MatchQueueStatus = 'open' | 'matched' | 'discarded';

/** MUL clearance lifecycle (append-only history in mul_clearance_transitions). */
export type MulClearanceState = 'draft' | 'requested' | 'cleared' | 'disputed';

/** The current MUL clearance state for one catalog asset — upsert per asset. */
export interface MulClearanceRecord {
  asset_cbt_code: string;
  state: MulClearanceState;
  licensee: string | null;
  territory: string | null;
  term_start: string | null;
  term_end: string | null;
  updated_at: string;
}

/** One append-only state transition in an asset's clearance history. */
export interface MulClearanceTransitionRecord {
  id: string;
  asset_cbt_code: string;
  from_state: MulClearanceState | null;
  to_state: MulClearanceState;
  note: string | null;
  created_at: string;
}

/** The caller's decision when closing a quarantined event. */
export type MatchQueueResolution =
  | { status: 'matched'; cbtCode: string }
  | { status: 'discarded' };

/**
 * One quarantined royalty event awaiting exact match — the raw payload is
 * preserved verbatim so recovery never re-parses from lossy intermediates.
 */
export interface MatchQueueRecord {
  id: string;
  event_id: string;
  status: MatchQueueStatus;
  reason: string;
  rights_pipeline: RightsPipeline;
  source: StatementSource;
  platform: string | null;
  territory: string | null;
  period: string | null;
  currency: string | null;
  /** Fixed-point gross in micros — text, never a float. */
  gross_micros: string | null;
  /** Parsed identifiers (ISRC/ISWC/ISNI/IPI-CAE…) as JSON text. */
  identifiers_json: string | null;
  raw_payload: string;
  matched_cbt_code: string | null;
  resolved_at: string | null;
  created_at: string;
}

/** Provenance record for one ingested statement file. */
export interface StatementIngestRecord {
  id: string;
  format: StatementFormat;
  source: StatementSource;
  file_name: string;
  content: string;
  status: StatementIngestStatus;
  event_count: number | null;
  error: string | null;
  created_at: string;
}
