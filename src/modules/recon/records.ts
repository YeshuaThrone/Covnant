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
  /** Podcast lane (PR 11): split accrual rows written this pass — one per
   * funding event (unique on source_event_id, the replay guard). */
  podcast_split_accruals?: number;
  /** Podcast lane: split accruals that already existed — counted no-ops. */
  podcast_split_replays?: number;
  /** Podcast lane: guest milestone bonuses accrued (holding credits posted). */
  podcast_bonus_accrued?: number;
  /** Podcast lane: milestone crossings already accrued — counted no-ops. */
  podcast_bonus_replayed?: number;
  /** Gaming lane (PR 12): gaming queue rows written (`gaming:line:` space). */
  gaming_written?: number;
  /** Gaming lane: same-row replays caught by the event-id guard. */
  gaming_replayed?: number;
  /** Gaming lane: Epic-family gross recorded into the per-product annual
   * accumulator this pass (the threshold's denominator), exact micros text. */
  gaming_accumulator_gross_micros?: string;
  /** Gaming lane: engine royalty deducted across the pass's posts (the
   * marginal 3.5% above the $1M annual per-product threshold), exact
   * fixed-point micros as text (never a float). */
  gaming_engine_royalty_micros?: string;
  /** Gaming lane: platform commission deducted across the pass's posts,
   * exact fixed-point micros as text (never a float). */
  gaming_commission_micros?: string;
  /** Gaming lane: per-item split payout routings written this pass — one
   * per funding event (unique on source_event_id, the replay guard). */
  gaming_split_payouts?: number;
  /** Gaming lane: payout routings that already existed — counted no-ops. */
  gaming_split_replays?: number;
  /** Gaming lane: resale-royalty micro-payout credits posted this pass
   * (the original creator's own holding credit per funding line + payee). */
  gaming_royalty_payouts?: number;
  /** Gaming lane: royalty credits whose post hit the per-source replay
   * guard — counted no-ops. */
  gaming_royalty_replays?: number;
  /** Gaming lane: postable lines whose item has no registered schedule —
   * honest skips (the credit releases through the manual-split path). */
  gaming_split_skipped_no_schedule?: number;
  /** Livestream lane (PR 14): queue rows written this pass. */
  livestream_written?: number;
  /** Livestream lane: same-row replays caught by the event-id guard. */
  livestream_replayed?: number;
  /** Livestream lane: durable virtual-currency conversion logs written this
   * pass (Bits/Diamonds rows — the founder's rate-logging rule, made
   * durable before any fiat movement posts). */
  livestream_conversions_logged?: number;
  /** Livestream lane: conversion logs that already existed — counted no-ops. */
  livestream_conversions_replayed?: number;
  /** Livestream lane: the Kick 95/5 platform fee deducted across the pass's
   * posts, exact fixed-point micros as text (never a float). */
  livestream_platform_fee_micros?: string;
  /** Livestream lane: esports prize-pool receipts locked into the batch
   * escrow this pass (never the unclaimed holding). */
  livestream_prize_pools_locked?: number;
  /** Livestream lane: prize-pool receipts whose escrow lock hit the
   * per-source replay guard — counted no-ops. */
  livestream_prize_pools_replayed?: number;
  /** Livestream lane: integer cents locked into esports batch escrows this
   * pass. */
  livestream_prize_pool_locked_cents?: number;
  /** Webtoon lane: queue rows written this pass (claims, consumption
   * facts, money rows, KENP pool rows). */
  webtoon_written?: number;
  /** Webtoon lane: same-row replays caught by the event-id guard. */
  webtoon_replayed?: number;
  /** Webtoon lane: reader-log monthly-pass claims written this pass — the
   * dedup's first movers (a claim quarantines any later pay-per-chapter
   * payout row for the same reading event). */
  webtoon_pass_claims?: number;
  /** Webtoon lane: pay-per-chapter payout rows quarantined by a pass
   * claim this pass (the founder's double-dip rule — visible, never
   * posted, never counted as revenue). */
  webtoon_pass_deduped?: number;
  /** Webtoon lane: pass reads whose reading event was already paid as a
   * coin payout (the payout landed first) — honestly visible, never
   * double-counted. */
  webtoon_paid_as_coin?: number;
  /** Webtoon lane: durable virtual-currency conversion logs written this
   * pass (coin-payout rows — the founder's rate-logging rule, made durable
   * before any fiat movement posts). */
  webtoon_conversions_logged?: number;
  /** Webtoon lane: conversion logs that already existed — counted no-ops. */
  webtoon_conversions_replayed?: number;
  /** Webtoon lane: the pinned Apple/Google App Store cut deducted across
   * the pass's posts, exact fixed-point micros as text (never a float). */
  webtoon_store_cut_micros?: string;
  /** Webtoon lane: the platform 30-50% split deducted across the pass's
   * posts, exact fixed-point micros as text (never a float). */
  webtoon_platform_split_micros?: string;
  /** Webtoon lane: integer cents posted for KENP page-read pool rows this
   * pass (pages × the period's recorded Global Fund rate). */
  webtoon_kenp_payout_cents?: number;
  /** Merch lane (PR 22): queue rows written this pass (DTC, POD,
   * consignment, and POS fulfillment events). */
  merch_written?: number;
  /** Merch lane: same-row replays caught by the event-id guard. */
  merch_replayed?: number;
  /** Merch lane: negative-net rows written into quarantine — a dump row
   * whose cost legs exceed its gross (visible, never posted). */
  merch_held_negative_net?: number;
  /** Merch lane: sub-cent/zero nets — recorded in the queue row, never
   * rounded up into the integer-cent ledger. */
  merch_zero_net?: number;
  /** Merch lane: production COGS / printing costs recorded across the
   * pass's deductions, exact fixed-point micros as text (never a float) —
   * the FIFO amortization engine's debt-side input. */
  merch_cogs_micros?: string;
  /** Merch lane: consignment shrinkage allowances offset against net
   * payout settlements this pass, exact fixed-point micros as text. */
  merch_shrinkage_offset_micros?: string;
  /** AI lane (PR 24): queue rows written this pass (OpenAI/W&B billing
   * events, ElevenLabs voice events, and Hugging Face attribution rows). */
  ai_written?: number;
  /** AI lane: same-row replays caught by the event-id guard. */
  ai_replayed?: number;
  /** AI lane: rows held in quarantine — a voice event without a voice
   * actor of record, an inference event whose model is unregistered, an
   * unattributed event whose model registry is empty (visible, never
   * posted, never dropped). */
  ai_held?: number;
  /** AI lane: legs credited to UNCLAIMED_HOLDING this pass — the nested
   * split's fee/developer/operator legs, the per-contributor attribution
   * legs, and the direct-to-actor voice licensing legs. */
  ai_legs_posted?: number;
  /** AI lane: legs whose post hit the per-source replay guard — no-ops. */
  ai_legs_replayed?: number;
  /** AI lane: sub-cent legs — recorded in their queue rows, never rounded
   * up into the integer-cent ledger. */
  ai_legs_zero_net?: number;
  /** AI lane: base foundation model provider system fees posted, exact
   * fixed-point micros as text (never a float). */
  ai_fee_micros?: string;
  /** AI lane: fine-tuner/LoRA creator splits posted, exact fixed-point
   * micros as text. */
  ai_developer_micros?: string;
  /** AI lane: model operator margins posted (the computed complement),
   * exact fixed-point micros as text. */
  ai_operator_micros?: string;
  /** AI lane: per-contributor attribution micro-royalties posted, exact
   * fixed-point micros as text. */
  ai_attribution_micros?: string;
  /** AI lane: voice licensing fees posted DIRECTLY to the original voice
   * actors of record, exact fixed-point micros as text. */
  ai_voice_licensing_micros?: string;
  /** AI lane: training-pool royalties distributed pro-rata by registered
   * dataset token weights, exact fixed-point micros as text. */
  ai_pool_royalty_micros?: string;
  /** AI lane: pro-rata floor residue swept visibly, exact fixed-point
   * micros as text (never rounded up into a contributor's credit). */
  ai_pool_dust_micros?: string;
  /** Book lane: match_queue rows written / replayed (the UNIQUE event_id
   * no-ops across a re-shipped report). */
  book_written?: number;
  book_replayed?: number;
  /** Book lane: matched vs unmatched rows (the ISBN vault cross-reference). */
  book_matched?: number;
  book_unmatched?: number;
  /** Book lane: negative-net quarantines / sub-cent zero nets — recorded,
   * never posted. */
  book_held_negative_net?: number;
  book_zero_net?: number;
  /** Book lane: the print rows' total recorded POD deductions, exact
   * fixed-point micros as text. */
  book_print_deduction_micros?: string;
  /** Book lane: holding posts / replays. */
  book_holding_posted?: number;
  book_holding_replayed?: number;
  /** Book lane: recoupment applications written / replayed events, integer
   * cents applied to pools this pass. */
  book_recoupments_applied?: number;
  book_recoupments_replayed?: number;
  book_recoupment_applied_cents?: number;
  /** Book lane: post-clearance royalty — integer cents that flowed past
   * the advance sequence (the splits' basis). */
  book_recoupment_excess_cents?: number;
  /** Book lane: editorial split accruals written / replayed. */
  book_split_accruals?: number;
  book_split_accruals_replayed?: number;
  /** Book lane: rows with no pool registered (money stays in holding) and
   * rows with no editorial schedule (honest skips, never silent drops). */
  book_skipped_no_pool?: number;
  book_skipped_no_schedule?: number;
  /** Art lane: match_queue rows written / replayed (the UNIQUE event_id
   * no-ops across a re-shipped report). */
  art_written?: number;
  art_replayed?: number;
  /** Art lane: matched vs unmatched rows (the Artwork ID vault
   * cross-reference). */
  art_matched?: number;
  art_unmatched?: number;
  /** Art lane: negative-net quarantines, sub-cent zero nets, no-ARR
   * primary-sale rows, and audit attestations — recorded, never posted. */
  art_held_negative_net?: number;
  art_zero_net?: number;
  art_no_arr?: number;
  art_audit_recorded?: number;
  /** Art lane: holding posts / replays. */
  art_holding_posted?: number;
  art_holding_replayed?: number;
  /** Art lane: resale rows' statutory royalties, duty offsets, and net
   * secondary royalties, exact fixed-point micros as text. */
  art_arr_royalty_micros?: string;
  art_arr_duty_offset_micros?: string;
  art_arr_net_micros?: string;
  /** Art lane: museum licensing fees, agency collection deductions, and
   * the isolated Don Ledger net, exact fixed-point micros as text. */
  art_licensing_fee_micros?: string;
  art_licensing_agency_deduction_micros?: string;
  art_licensing_net_micros?: string;
  /** Art lane: fabrication recoupment applications written / replayed
   * events, integer cents applied to pools this pass. */
  art_recoupments_applied?: number;
  art_recoupments_replayed?: number;
  art_recoupment_applied_cents?: number;
  /** Art lane: post-clearance net — integer cents that flowed past the
   * fabrication debt sequence (the splits' basis). */
  art_recoupment_excess_cents?: number;
  /** Art lane: fabrication split accruals written / replayed. */
  art_split_accruals?: number;
  art_split_accruals_replayed?: number;
  /** Art lane: sales with no fabrication pool registered (money stays in
   * holding) and sales with no split schedule (honest skips, never silent
   * drops). */
  art_skipped_no_pool?: number;
  art_skipped_no_schedule?: number;
  /** Theatrical lane: match_queue rows written / replayed (the UNIQUE
   * event_id no-ops across a re-shipped settlement report). */
  theatrical_written?: number;
  theatrical_replayed?: number;
  /** Theatrical lane: matched vs unmatched rows. */
  theatrical_matched?: number;
  theatrical_unmatched?: number;
  /** Theatrical lane: negative-net quarantines and sub-cent zero nets —
   * recorded, never posted. */
  theatrical_held_negative_net?: number;
  theatrical_zero_net?: number;
  /** Theatrical lane: holding posts / replays. */
  theatrical_holding_posted?: number;
  theatrical_holding_replayed?: number;
  /** Theatrical lane: the stops' GBOR and AGBOR legs, exact fixed-point
   * micros as text (the AGBOR calculator's totals across the pass). */
  theatrical_gbor_micros?: string;
  theatrical_deductions_micros?: string;
  theatrical_agbor_micros?: string;
  /** Theatrical lane: Grand Rights deductions across stops, integer cents. */
  theatrical_grand_rights_cents?: number;
  /** Theatrical lane: venue expenses recouped and the capped overage left
   * with the promoter, integer cents. */
  theatrical_venue_expense_recouped_cents?: number;
  theatrical_venue_expense_capped_cents?: number;
  /** Theatrical lane: deal payouts designated across stops, integer cents. */
  theatrical_deal_payout_cents?: number;
  /** Theatrical lane: stops that crossed the capitalization budget — the
   * automatic 50/50 switchover events. */
  theatrical_recoupment_switchovers?: number;
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
