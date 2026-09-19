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

import type { SyncLicenseType } from '../../../covnant-sdk/src/contracts/syncLibraryMarketplace';

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

/**
 * Where a quarantined event arrived from — the canonical royalty event's
 * ingress vocabulary (covnant-sdk/src/contracts/royalty-event.ts), carried
 * verbatim so queue provenance never folds a webhook or API-pull event
 * into the statement-ingest vocabulary below.
 */
export type MatchQueueSource = 'webhook' | 'statement' | 'api_pull';

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
  /** The event's ingress source, verbatim from the canonical event. */
  source: MatchQueueSource;
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

// --- Sync Library catalog + purchases (migration 0008 — the
//     SyncMarketplaceRegistry amendment, spec art_ZIdWlYUX) ---

/**
 * The migration-0008 catalog columns for one asset, keyed by its CBT code.
 * NOT a new asset table — the asset's identity (title, medium, rights
 * holders) stays in cbt_assets; these are the additive sync-library columns
 * the amendment locks, projected per backend. `is_pre_cleared` is the
 * pending pre-clearance state: registrations land false and only a gated
 * administrator action flips them.
 */
export interface SyncCatalogItemRecord {
  cbt_code: string;
  is_pre_cleared: boolean;
  sync_fee_cents: number;
  genre: string;
  bpm: number | null;
  updated_at: string;
}

/**
 * The licensing settlement lane's write-back record — one settled sync
 * license purchase. `cbt_settlement_stamp` is the server-minted stamp
 * (withCbtSettlementCode over the purchase reference); UNIQUE, and the
 * replay key: duplicate purchases land on the idempotent existing row.
 * `split_run_id` links the single calculateUdrSplits run that partitioned
 * the fee 50/35/15 and credited the tier vaults. `metadata` carries the
 * withCbtSettlementCode merge output — the cbt lineage tag, same provenance
 * shape the settlement wire stamps onto ledger rows.
 */
export interface SyncLicensePurchaseRecord {
  id: string;
  cvt_asset_tag: string;
  buyer_uct: string;
  license_type: SyncLicenseType;
  fee_paid_cents: number;
  cbt_settlement_stamp: string;
  split_run_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
