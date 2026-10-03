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
  /** Licensing lane (PR 32): write-pass counts and the addendum 12 triple's
   * honest classification (every validated row carries one). */
  licensing_written?: number;
  licensing_replayed?: number;
  licensing_matched?: number;
  licensing_unmatched?: number;
  /** Licensing lane: quarantined rows — negative nets visible, zero nets
   * recorded, never walked, never posted. */
  licensing_held_negative_net?: number;
  licensing_zero_net?: number;
  /** Licensing lane: holding posts of the computed Net Licensed Sales. */
  licensing_holding_posted?: number;
  licensing_holding_replayed?: number;
  /** Licensing lane: the deduction legs recorded across rows, verbatim
   * fixed-point micros as text (the Net Sales gap of record). */
  licensing_net_sales_deduction_micros?: string;
  /** Licensing lane: the tier walk's commits and counted replay no-ops. */
  licensing_applications_committed?: number;
  licensing_applications_replayed?: number;
  /** Licensing lane: fail-closed skips — no deal of record, or a currency
   * the deal of record does not price. */
  licensing_skipped_no_deal?: number;
  licensing_currency_mismatch?: number;
  /** Licensing lane: the sub-license cascade — reports written and replayed,
   * the audit gate's held reports, and the releases posted (only ever from
   * 'reconciled' reports of record). */
  licensing_sub_reports_written?: number;
  licensing_sub_reports_replayed?: number;
  licensing_sub_held_pending_audit?: number;
  licensing_sub_releases_posted?: number;
  licensing_sub_releases_replayed?: number;
  licensing_skipped_no_sub_licensee?: number;
  /** Licensing lane: the walk's earned gross royalties, the agency
   * commission deducted, and the treaty withholding held back, integer
   * cents; payout legs HELD for uncovered international pairs. */
  licensing_royalty_gross_cents?: number;
  licensing_agency_commission_cents?: number;
  licensing_withheld_cents?: number;
  licensing_payout_legs_held?: number;
  /** NIL lane (PR 34): the compliance parser's deal payouts — commits and
   * counted replay no-ops, and the two held verdicts (held money is
   * visible, never dropped, never posted). */
  nil_payouts_committed?: number;
  nil_payouts_replayed?: number;
  nil_payouts_held_compliance?: number;
  nil_payouts_held_state_rule?: number;
  /** NIL lane: the valid business purpose audit — $600 flags raised and
   * metadata matches that healed 'flagged' → 'nil_cleared'. */
  nil_deal_audits_flagged?: number;
  nil_deal_audits_cleared?: number;
  /** NIL lane: the adjusted calculator's pool walks — commits, counted
   * replay no-ops, and the fail-closed skips (no program of record, no
   * waterfall of record — money never guessed). */
  nil_pool_walks_committed?: number;
  nil_pool_walks_replayed?: number;
  nil_pool_walks_skipped_no_program?: number;
  nil_pool_walks_skipped_no_waterfall?: number;
  /** NIL lane: the group NIL equal splits — commits and counted replay
   * no-ops. */
  nil_group_splits_committed?: number;
  nil_group_splits_replayed?: number;
  /** NIL lane: the payout gate states upserted across the pass. */
  nil_gate_states_upserted?: number;
  /** NIL lane: the committed money, integer cents — deal gross, agency
   * fees deducted at payout, net deal payouts, and the pool walk's net
   * share pool / roster paid / dust (the conservation identities' legs). */
  nil_deal_gross_cents?: number;
  nil_agency_fees_cents?: number;
  nil_net_payout_cents?: number;
  nil_net_athlete_share_pool_cents?: number;
  nil_roster_paid_cents?: number;
  nil_dust_cents?: number;
  /** Spatial lane (PR 36): the occupancy royalty walk's applications —
   * commits, counted replay no-ops, the fail-closed skips (no schedule /
   * unverified schedule / no overhead policy of record), and the negative
   * net holds (held money is visible, never dropped, never posted). */
  spatial_occupancy_applications_committed?: number;
  spatial_occupancy_applications_replayed?: number;
  spatial_occupancy_skipped_no_schedule?: number;
  spatial_occupancy_skipped_unverified_schedule?: number;
  spatial_occupancy_skipped_no_overhead?: number;
  spatial_occupancy_held_negative_net?: number;
  /** Spatial lane: the zone allocation walk — the zone's sales routed to
   * the assigned IP owner's waterfall, overhead-first. */
  spatial_zone_allocations_committed?: number;
  spatial_zone_allocations_replayed?: number;
  spatial_zone_skipped_no_assignment?: number;
  spatial_zone_skipped_no_overhead?: number;
  /** Spatial lane: the dynamic micro-royalty ledger — the dwell/session
   * payouts at the zone's unit rates of record. */
  spatial_micro_royalties_committed?: number;
  spatial_micro_royalties_replayed?: number;
  spatial_micro_skipped_no_policy?: number;
  /** Spatial lane: the committed money, integer cents — the Adjusted
   * Location Sales nets, the shared facility overhead deducted, and the
   * three royalty legs the walk priced. */
  spatial_net_spatial_licensed_revenue_cents?: number;
  spatial_overhead_total_cents?: number;
  spatial_occupancy_royalty_cents?: number;
  spatial_zone_royalty_cents?: number;
  spatial_micro_royalty_cents?: number;
  /** Fitness lane (PR 38): the Digital Stream Realization walk — the
   * Net Fitness Content Pool of record. */
  fitness_realization_applications_committed?: number;
  fitness_realization_applications_replayed?: number;
  fitness_realization_held_negative_net?: number;
  /** Fitness lane: the trainer royalty walk — the sync music deductions
   * FIRST, then the cumulative tier walk and the retention bonus. */
  fitness_royalty_applications_committed?: number;
  fitness_royalty_applications_replayed?: number;
  fitness_royalty_skipped_no_tier_schedule?: number;
  fitness_royalty_skipped_no_sync_policy?: number;
  fitness_royalty_held_negative_net?: number;
  /** Fitness lane: the live-event streaming residual walk — the server
   * load bands at the peak simultaneous viewers. */
  fitness_live_residuals_committed?: number;
  fitness_live_residuals_replayed?: number;
  fitness_live_skipped_no_load_policy?: number;
  /** Fitness lane: the franchise override walk — certified-content
   * overrides + the network fee BEFORE the instructor disbursement. */
  fitness_franchise_applications_committed?: number;
  fitness_franchise_applications_replayed?: number;
  fitness_franchise_skipped_no_policy?: number;
  fitness_franchise_held_negative_net?: number;
  /** Fitness lane: the co-branded franchise split walk — the net class
   * stream earnings between the IP owner and the distributor. */
  fitness_cobrand_splits_committed?: number;
  fitness_cobrand_splits_replayed?: number;
  fitness_cobrand_skipped_no_partnership?: number;
  /** Fitness lane: the wearable / algorithm micro-royalty ledger — the
   * daily active feature usage at the policy's micro-fee. */
  fitness_algorithm_royalties_committed?: number;
  fitness_algorithm_royalties_replayed?: number;
  fitness_algorithm_skipped_no_policy?: number;
  /** Fitness lane: the multi-trainer co-creation waterfall — the
   * module-weighted split of the realized pool. */
  fitness_cocreation_applications_committed?: number;
  fitness_cocreation_applications_replayed?: number;
  fitness_cocreation_skipped_no_waterfall?: number;
  /** Fitness lane: the committed money, integer cents — the realized
   * pool and every leg the seven walks priced. */
  fitness_net_fitness_content_pool_cents?: number;
  fitness_trainer_tier_payout_cents?: number;
  fitness_retention_bonus_cents?: number;
  fitness_sync_music_deduction_cents?: number;
  fitness_server_load_deduction_cents?: number;
  fitness_franchise_override_cents?: number;
  fitness_network_fee_cents?: number;
  fitness_instructor_disbursement_cents?: number;
  fitness_cobrand_ip_owner_cents?: number;
  fitness_cobrand_distributor_cents?: number;
  fitness_algorithm_royalty_cents?: number;
  fitness_cocreation_allocated_cents?: number;
  /** Food lane (PR 40): the Net Recipe Realization walk — the founder's
   * exact identity and the Net Culinary IP Pool of record. */
  food_realization_applications_committed?: number;
  food_realization_applications_replayed?: number;
  food_realization_held_negative_net?: number;
  /** Food lane: the tiered recipe royalty walk — the per-dish micro-payout
   * band walk and the percentage split on the location's cumulative
   * monthly units (4% scaling to 7% strictly POST the threshold). */
  food_royalty_applications_committed?: number;
  food_royalty_applications_replayed?: number;
  food_royalty_skipped_no_schedule?: number;
  food_royalty_held_negative_net?: number;
  /** Food lane: the weighted co-branded menu split — the recipe royalty
   * pot routed per the ingredient and brand weightings of record. */
  food_cobrand_splits_committed?: number;
  food_cobrand_splits_replayed?: number;
  food_cobrand_skipped_no_weightings?: number;
  /** Food lane: the host kitchen operator split — the margin routes
   * directly to the local operator while the brand licensor's percentage
   * cut holds back. */
  food_host_operator_splits_committed?: number;
  food_host_operator_splits_replayed?: number;
  food_host_operator_skipped_no_policy?: number;
  /** Food lane: the cook-cycle micro-royalty ledger — per-execution
   * micro-fees at the policy of record. */
  food_cook_cycle_royalties_committed?: number;
  food_cook_cycle_royalties_replayed?: number;
  food_cook_cycle_skipped_no_policy?: number;
  /** Food lane: the supplier rebate routing — the volume kickback passed
   * proportionally back to the virtual franchise operators. */
  food_supplier_rebates_committed?: number;
  food_supplier_rebates_replayed?: number;
  food_supplier_rebates_skipped_no_waterfall?: number;
  /** Food lane: the committed money, integer cents — the realized pool
   * and every leg the walks priced. */
  food_net_culinary_ip_pool_cents?: number;
  food_unit_payout_cents?: number;
  food_percentage_split_cents?: number;
  food_cobrand_allocated_cents?: number;
  food_host_operator_cents?: number;
  food_brand_licensor_holdback_cents?: number;
  food_cook_cycle_royalty_cents?: number;
  food_supplier_rebate_routed_cents?: number;
  // The service lane (PR 42) — the same result discipline: the service_*
  // block is absent on every other lane; its presence is the
  // discriminator.
  /** Service lane: the Net Service Realization applications — the
   * calculator rows committed, the counted replay no-ops, and the
   * negative-net holds (the money pauses, visible). */
  service_realization_applications_committed?: number;
  service_realization_applications_replayed?: number;
  service_realization_held_negative_net?: number;
  /** Service lane: the franchise contract's three-way gross partition —
   * committed / counted replay no-ops / fail-closed skips (no schedule
   * of record for the location). */
  service_franchise_splits_committed?: number;
  service_franchise_splits_replayed?: number;
  service_franchise_skipped_no_schedule?: number;
  /** Service lane: the protocol execution micro-royalties — committed /
   * counted replay no-ops / fail-closed skips (no protocol policy of
   * record). */
  service_protocol_royalties_committed?: number;
  service_protocol_royalties_replayed?: number;
  service_protocol_skipped_no_policy?: number;
  /** Service lane: the cross-location redemption splits — committed /
   * counted replay no-ops / fail-closed skips (no redemption policy of
   * record at the home location). */
  service_redemption_splits_committed?: number;
  service_redemption_splits_replayed?: number;
  service_redemption_skipped_no_policy?: number;
  /** Service lane: the breakage allocations — committed / counted replay
   * no-ops / fail-closed skips (no breakage policy of record at the home
   * location). */
  service_breakage_allocations_committed?: number;
  service_breakage_allocations_replayed?: number;
  service_breakage_skipped_no_policy?: number;
  /** Service lane: the vendor rebate routings — committed / counted
   * replay no-ops / fail-closed skips (no registered waterfall of
   * record). */
  service_rebate_routings_committed?: number;
  service_rebate_routings_replayed?: number;
  service_rebate_skipped_no_waterfall?: number;
  /** Service lane: the booth-lease splits — committed / counted replay
   * no-ops / fail-closed skips (no booth-lease policy of record). */
  service_booth_lease_splits_committed?: number;
  service_booth_lease_splits_replayed?: number;
  service_booth_skipped_no_policy?: number;
  /** Service lane: the committed money, integer cents — the realized
   * pool and every leg the walks priced. */
  service_net_realized_service_pool_cents?: number;
  service_franchisor_royalty_cents?: number;
  service_technician_commission_cents?: number;
  service_house_margin_cents?: number;
  service_protocol_royalty_cents?: number;
  service_redemption_franchisor_royalty_cents?: number;
  service_home_admin_cents?: number;
  service_visiting_location_cents?: number;
  service_breakage_franchisor_cents?: number;
  service_breakage_franchisee_cents?: number;
  service_rebate_routed_cents?: number;
  service_chair_rent_cents?: number;
  service_retail_commission_cents?: number;
  // The developer lane (PR 44) — the same result discipline: the
  // developer_* block is absent on every other lane; its presence is the
  // discriminator.
  /** Developer lane: the Net API Realization applications — the
   * calculator rows committed, the counted replay no-ops, and the
   * negative-net holds (the money pauses, visible). */
  developer_realization_applications_committed?: number;
  developer_realization_applications_replayed?: number;
  developer_realization_held_negative_net?: number;
  /** Developer lane: the tiered micro-royalties — committed / counted
   * replay no-ops / fail-closed skips (no royalty policy of record, a
   * per-call policy on a call-free row, or a usage-share royalty on a
   * HELD row). */
  developer_micro_royalties_committed?: number;
  developer_micro_royalties_replayed?: number;
  developer_micro_royalties_skipped_no_policy?: number;
  /** Developer lane: the marketplace splits — committed / counted replay
   * no-ops / fail-closed skips (no marketplace split policy of record). */
  developer_marketplace_splits_committed?: number;
  developer_marketplace_splits_replayed?: number;
  developer_marketplace_skipped_no_policy?: number;
  /** Developer lane: the co-authored package splits — committed / counted
   * replay no-ops / fail-closed skips (no registered weightings). */
  developer_copackage_splits_committed?: number;
  developer_copackage_splits_replayed?: number;
  developer_copackage_skipped_no_legs?: number;
  /** Developer lane: the SBOM dependency micro-fees — committed / counted
   * replay no-ops / fail-closed skips (no maintainer ledger of record). */
  developer_dependency_fees_committed?: number;
  developer_dependency_fees_replayed?: number;
  developer_dependency_skipped_no_ledger?: number;
  /** Developer lane: the white-label settlements — committed / counted
   * replay no-ops / fail-closed skips (no deal of record). */
  developer_whitelabel_settlements_committed?: number;
  developer_whitelabel_settlements_replayed?: number;
  developer_whitelabel_skipped_no_deal?: number;
  /** Developer lane: the agent tool-call settlements — committed / counted
   * replay no-ops / fail-closed skips (no settlement policy of record). */
  developer_tool_call_settlements_committed?: number;
  developer_tool_call_settlements_replayed?: number;
  developer_tool_call_skipped_no_policy?: number;
  /** Developer lane (PR 45): the instant postings — journals written the
   * moment detector events priced (sub-cent pots record rows, no
   * journal, and are NOT counted here). */
  developer_tool_call_instant_postings?: number;
  /** Developer lane: the committed money, integer cents — the realized
   * pool and every leg the walks priced. */
  developer_net_code_usage_pool_cents?: number;
  developer_micro_royalty_cents?: number;
  developer_marketplace_platform_cents?: number;
  developer_marketplace_developer_net_cents?: number;
  developer_copackage_allocated_cents?: number;
  developer_dependency_fee_cents?: number;
  developer_whitelabel_recouped_cents?: number;
  developer_whitelabel_overage_royalty_cents?: number;
  developer_tool_call_builder_cents?: number;
  developer_tool_call_platform_cents?: number;
  /** Hardware lane (PR 46, the founder hardware directive): the seven
   * walks — committed / counted replay no-ops / fail-closed skips, per
   * walk (realizations, SEP royalties, OEM routings, pool waterfalls,
   * telemetry royalties, cross-license nettings, OTA unlock
   * settlements). */
  hardware_realizations_committed?: number;
  hardware_realizations_replayed?: number;
  hardware_realization_held_non_positive_net?: number;
  hardware_sep_royalties_committed?: number;
  hardware_sep_royalties_replayed?: number;
  hardware_sep_skipped_no_policy?: number;
  hardware_oem_routings_committed?: number;
  hardware_oem_routings_replayed?: number;
  hardware_oem_skipped_no_assignment?: number;
  hardware_pool_waterfalls_committed?: number;
  hardware_pool_waterfalls_replayed?: number;
  hardware_pool_skipped_no_pool?: number;
  hardware_telemetry_royalties_committed?: number;
  hardware_telemetry_royalties_replayed?: number;
  hardware_telemetry_skipped_no_policy?: number;
  hardware_cross_license_nettings_committed?: number;
  hardware_cross_license_nettings_replayed?: number;
  hardware_cross_license_skipped_no_agreement?: number;
  hardware_ota_unlock_settlements_committed?: number;
  hardware_ota_unlock_settlements_replayed?: number;
  hardware_ota_unlock_skipped_no_policy?: number;
  /** Hardware lane (PR 46): the instant postings — journals written the
   * moment an OTA unlock priced (the PR 45 precedent). */
  hardware_ota_unlock_instant_postings?: number;
  /** Hardware lane: the committed money, integer cents — the realization
   * value bases and every leg the walks priced (the cross-license net
   * dispatch is the NETTED settlement, not the gross liabilities). */
  hardware_net_patentable_value_base_cents?: number;
  hardware_sep_royalty_cents?: number;
  hardware_oem_routed_cents?: number;
  hardware_pool_distributed_cents?: number;
  hardware_telemetry_royalty_cents?: number;
  hardware_cross_license_net_dispatch_cents?: number;
  hardware_ota_licensor_cents?: number;
  hardware_ota_platform_cents?: number;
  /** Energy lane (PR 48, the founder resource directive): the walks —
   * committed / counted replay no-ops / fail-closed skips, per walk
   * (realizations, parcel tier royalties, acreage divisions, statutory
   * interest accruals, GPU yields, telemetry grid splits, carbon
   * payouts). The row replay counter rides all four senders' replay
   * guards — a re-shipped sheet replays every row behind it. */
  energy_realizations_committed?: number;
  energy_rows_replayed?: number;
  energy_realization_held_negative_net?: number;
  energy_parcel_royalties_committed?: number;
  energy_parcel_royalties_skipped_no_policy?: number;
  energy_divisions_committed?: number;
  energy_divisions_skipped_no_interests?: number;
  energy_statutory_interest_accruals_committed?: number;
  energy_gpu_yields_committed?: number;
  energy_gpu_yields_skipped_no_policy?: number;
  energy_grid_splits_committed?: number;
  energy_grid_splits_skipped_no_participants?: number;
  energy_carbon_payouts_committed?: number;
  energy_carbon_payouts_skipped_no_policy?: number;
  /** Energy lane: the committed money, integer cents — the pass's
   * Net Realized Resource Pool DELTA (the per-tuple after − before of
   * record, additive across jobs; includes held negative nets) and
   * every leg the walks priced. */
  energy_net_realized_resource_pool_delta_cents?: number;
  energy_parcel_royalty_cents?: number;
  energy_divided_cents?: number;
  energy_statutory_interest_accrued_cents?: number;
  energy_gpu_yield_cents?: number;
  energy_grid_split_cents?: number;
  energy_carbon_payout_total_cents?: number;
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
