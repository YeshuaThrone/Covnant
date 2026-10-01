export type CompanyDustRecord = {
  id: string;
  split_run_id: string;
  line_item_id: string;
  amount_cents: number;
  variance_account_id: string;
  created_at: string;
};

export type CreatorTaxProfile = {
  creator_id: string;
  tin_verified: number;
  w9_on_file: number;
  updated_at: string;
};

export type CreatorYtdEarnings = {
  creator_id: string;
  tax_year: number;
  gross_cents: number;
  withheld_cents: number;
  updated_at: string;
};

export type TaxEscrowRecord = {
  id: string;
  creator_id: string;
  tax_year: number;
  gross_cents: number;
  withheld_cents: number;
  net_cents: number;
  tin_verified: number;
  w9_on_file: number;
  requires_1099: number;
  crossed_1099_threshold: number;
  created_at: string;
};

export type SovereignVaultRecord = {
  payee_id: string;
  payee_name: string;
  available_balance: number;
  pending_balance: number;
  reserve_balance: number;
  updated_at: string;
};

/**
 * The Plaid processor vocabulary — distinct from the BaaS payout-provider
 * union: Lithic is a payout rail, never a Plaid processor.
 */
export const PLAID_PROCESSORS = ["column", "unit"] as const;
export type PlaidProcessor = (typeof PLAID_PROCESSORS)[number];

export type PlaidProcessorTokenRecord = {
  id: string;
  creator_id: string;
  public_token: string;
  processor: PlaidProcessor;
  processor_token: string;
  account_id: string;
  created_at: string;
};

export type RecoupmentAdvanceRecord = {
  creator_id: string;
  creator_name: string;
  recoupment_target_cents: number;
  recoupment_current_cents: number;
  recoupment_bps: number;
  updated_at: string;
};

export type VaultDisputeRecord = {
  payee_id: string;
  locked: number;
  line_item_id: string | null;
  frozen_from_available: number;
  frozen_from_pending: number;
  updated_at: string;
};

export type PayoutHoldRecord = {
  transfer_id: string;
  payee_id: string;
  amount_cents: number;
  status: "in_flight" | "settled" | "reversed";
  created_at: string;
};

export type BaasWebhookEventRecord = {
  id: string;
  event_id: string;
  event: string;
  transfer_id: string;
  payload_json: string;
  reversal_id: string | null;
  created_at: string;
};

export type PayoutReversalRecord = {
  id: string;
  transfer_id: string;
  payee_id: string;
  amount_cents: number;
  reason: "payout.returned" | "payout.failed";
  ledger_transaction_id: string | null;
  /**
   * Nullable (migration 0009): the reversal row is the engine's
   * insert-as-lock guard for one-transfer-one-reversal (audit H4), inserted
   * before the GL journal exists; the engine back-fills it after posting.
   */
  journal_id: string | null;
  created_at: string;
};

export type GlJournalRecord = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  created_at: string;
  sequence: number;
  prev_hash: string;
  entry_hash: string;
  state: "posted";
};

export type GlEntryRecord = {
  id: string;
  journal_id: string;
  account: string;
  debit_cents: number;
  credit_cents: number;
  created_at: string;
};

export type RecoupmentLedgerRecord = {
  id: string;
  creator_id: string;
  split_run_id: string;
  incoming_cents: number;
  recouped_cents: number;
  excess_cents: number;
  recoupment_current_cents: number;
  created_at: string;
};

export type CatalogDisputeRecord = {
  work_id: string;
  locked: number;
  updated_at: string;
};

export type DspWebhookEventRecord = {
  id: string;
  event_id: string;
  event: string;
  source: string;
  split_run_id: string | null;
  payload_json: string;
  created_at: string;
};

export type SplitReversalRecord = {
  id: string;
  split_run_id: string;
  journal_id: string;
  created_at: string;
};

// --- Film waterfall engine (PR 8, Deep Royalties) ---

/**
 * One registered film waterfall — the deal as verified at the cross-reference,
 * stored jsonb on `film_waterfall_definitions` (migration 0016), one row per
 * film asset. The `definition` field is the typed WaterfallDefinition the
 * waterfall module validates; the store projects the jsonb at the boundary
 * (the sync_license_purchases.metadata precedent).
 */
export type FilmWaterfallDefinitionRecord = {
  film_id: string;
  definition: import('@/modules/waterfall/engine').FilmWaterfallDefinition;
  created_at: string;
  updated_at: string;
};

export type FilmWaterfallDistributionStatus = 'routed' | 'applied';

/**
 * One routing decision on a released escrow receipt — the state that makes
 * shortfall carry honest. Inserted status 'routed' BEFORE the release moves
 * money (insert-as-lock, the payout-reversal precedent), flipped to 'applied'
 * when the release succeeds, DELETED when the release refuses (retryable).
 * Cumulative per-leg paid — the waterfall router's carry input — sums the
 * per-leg detail over APPLIED rows only. Unique on escrow_ledger_id: one
 * routing decision per released receipt, ever.
 */
export type FilmWaterfallDistributionRecord = {
  id: string;
  film_id: string;
  escrow_ledger_id: string;
  status: FilmWaterfallDistributionStatus;
  /** The First Dollar Gross bypass the routing took off the top, integer cents. */
  fdg_bypass_cents: number;
  /** The per-leg routing detail (the router's leg outcomes), stored jsonb. */
  legs: import('@/modules/waterfall/engine').WaterfallLegRouting[];
  /** The per-tier totals the release applied, stored jsonb. */
  tier_allocations: import('@/modules/waterfall/engine').WaterfallTierAllocation[];
  /** The honest carry this routing reported, integer cents. */
  unpaid_total_cents: number;
  created_at: string;
};

// --- Podcast episode splits + guest milestone bonuses (PR 11, migration 0017) ---

/**
 * One registered per-episode split schedule — the Don Ledger's episode-scoped
 * routing for podcast revenue (the founder podcast directive: a flagship
 * episode pays host 60 / co-host 30 / editor+producer 10 while the next
 * episode pays a different sheet entirely). One row per episode
 * (`podcast_episode_split_schedules`, migration 0017); the engine module
 * (src/modules/podcastSplits/engine.ts) is the registration gate — rows are
 * what passed it, keyed one schedule per episode with a monotonic version.
 */
export type PodcastEpisodeSplitScheduleRecord = {
  episode_id: string;
  /** The vault show the episode's DOI resolves to (matched_cbt_code), when known. */
  show_cbt_code: string | null;
  /**
   * The per-holder routing. share_bps must sum to EXACTLY 10000 (100.0000%)
   * — validated at registration and re-validated at every accrual.
   */
  splits: import('@/lib/don/types').SplitPartyInput[];
  /** Monotonic registration version — bumped on every accepted re-registration. */
  version: number;
  created_at: string;
  updated_at: string;
};

/**
 * One per-holder split accrual — the routing-decision record for ONE
 * holding credit (unique on source_event_id: the `podcast:imp:`/`podcast:sub:`
 * queue event that funded it, the same id the holding credit carries as its
 * line_item_id and journal ref). Written once per funding event, ever — a
 * replayed ingest re-derives the same source_event_id and the UNIQUE
 * constraint turns the replay into a counted no-op (the PR #93 per-source
 * guard pattern). Per-holder amounts are integer cents; allocations plus
 * company dust equal the source amount exactly (the locked Don invariant).
 */
export type PodcastEpisodeSplitAccrualRecord = {
  id: string;
  episode_id: string;
  /** UNIQUE — the funding queue event; one accrual per funding event, ever. */
  source_event_id: string;
  /** The creator net that was routed, integer cents. */
  source_amount_cents: number;
  /** The schedule version the accrual used. */
  split_version: number;
  /** The per-holder integer-cent accruals (floor shares, dust swept out). */
  accruals: import('@/lib/don/types').AllocatedSplit[];
  /** The integer-cent dust the sweep routed to the variance account. */
  company_dust_cents: number;
  created_at: string;
};

export type PodcastMilestoneKind = 'downloads' | 'reach';

/**
 * One registered guest milestone bonus — a contractual micro-payout that
 * triggers when an episode's VERIFIED IAB count crosses `threshold`
 * (downloads = qualified impressions; reach = all verified listening
 * including subscription rows). One row per (episode, guest, kind,
 * threshold); the engine module is the registration gate.
 */
export type PodcastGuestBonusDefinitionRecord = {
  id: string;
  episode_id: string;
  guest_payee_id: string;
  guest_payee_name: string;
  milestone_kind: PodcastMilestoneKind;
  /** The verified count that triggers the bonus — a safe integer ≥ 1. */
  threshold: number;
  /** The bonus paid on crossing, integer cents ≥ 1 (never a float). */
  bonus_amount_cents: number;
  /** ISO-4217 alpha-3 (the bonus posts to holding in this currency). */
  currency: string;
  created_at: string;
  updated_at: string;
};

export type PodcastGuestBonusAccrualStatus = 'accrued' | 'posted';

/**
 * One crossed milestone — the once-only record (unique on event_id, a
 * content-derived `podcast:bonus:` id over episode + definition + threshold).
 * Lifecycle mirrors the film routing decision (insert-as-lock): written
 * status 'accrued' BEFORE the holding post moves money, flipped 'posted' on
 * posting success, DELETED when the post refuses (retryable). A replayed
 * episode ingest derives the same event_id and the UNIQUE constraint makes
 * the replay a counted no-op — a threshold crossing accrues exactly once.
 */
export type PodcastGuestBonusAccrualRecord = {
  id: string;
  /** UNIQUE, content-derived — the replay arbiter and the journal ref. */
  event_id: string;
  episode_id: string;
  bonus_definition_id: string;
  guest_payee_id: string;
  milestone_kind: PodcastMilestoneKind;
  threshold: number;
  /** The verified count that crossed the threshold at accrual time. */
  verified_count: number;
  bonus_amount_cents: number;
  status: PodcastGuestBonusAccrualStatus;
  /** The holding credit the accrual posted, once posted. */
  holding_ledger_id: string | null;
  created_at: string;
};
