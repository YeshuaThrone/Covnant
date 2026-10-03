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
  definition: import("@/modules/waterfall/engine").FilmWaterfallDefinition;
  created_at: string;
  updated_at: string;
};

export type FilmWaterfallDistributionStatus = "routed" | "applied";

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
  legs: import("@/modules/waterfall/engine").WaterfallLegRouting[];
  /** The per-tier totals the release applied, stored jsonb. */
  tier_allocations: import("@/modules/waterfall/engine").WaterfallTierAllocation[];
  /** The honest carry this routing reported, integer cents. */
  unpaid_total_cents: number;
  created_at: string;
};

// --- Film multi-territory withholding + cross-collateralization firewall (PR 18, migration 0023) ---

/**
 * One film line's foreign-withholding log (migration 0023) — the per-line,
 * pre-conversion record. The withholding is computed on the SOURCE-currency
 * amount at the territory's pinned treaty rate and logged BEFORE anything
 * converts into the Don ledger base currency; the log row is the
 * foreign-tax-credit evidence and the rate+amount audit of record. UNIQUE on
 * event_id (the content-derived match_queue event): one withholding log per
 * line, ever — a replayed line recovers by reading the existing row.
 */
export type FilmTerritoryWithholdingRecord = {
  id: string;
  /** UNIQUE — the content-derived match_queue event id (addendum 6, migration 0011). */
  event_id: string;
  /** The film the line receipts against (the escrow/waterfall key). */
  film_id: string;
  /** The film tax jurisdiction (ISO 3166-1 alpha-2). */
  territory_code: string;
  /** Addendum 6's flag as the line carried it. */
  foreign_tax_withheld: boolean;
  /** The applied treaty rate in bps — 0 when the line was not withheld. */
  withholding_rate_bps: number;
  /** The rate-table version consulted — null when the line was not withheld. */
  rate_table_version: string | null;
  /** The statement's own denomination. */
  source_currency: string;
  /** Exact source amounts as decimal micros text — never a float. */
  gross_source_micros: string;
  withheld_source_micros: string;
  net_source_micros: string;
  /** The Don ledger base currency the net posts into. */
  base_currency: string;
  /** The applied FX rate (micros of base per source unit), logged with the conversion. */
  fx_rate_micros: number;
  /** Whole base-currency cents: the escrow posts the NET; the log carries all three. */
  gross_base_cents: number;
  withheld_base_cents: number;
  net_base_cents: number;
  created_at: string;
};

export type FilmTerritoryDistributionStatus = "routed" | "applied";

/** One cross-territorial application — the CAMA-permitted sweep's audit row. */
export type FilmTerritoryCrossApplication = {
  /** The territory whose obligation drew. */
  debtor_territory: string;
  /** The territory whose tier-5 residue funded it. */
  creditor_territory: string;
  /** The debtor's obligation leg the application satisfied. */
  debtor_leg_id: string;
  /** Exact integer cents that crossed. */
  applied_cents: number;
};

/**
 * One territory envelope's routing decision on a released escrow receipt
 * (migration 0023) — the territory partition of the film_waterfall_distributions
 * record (PR 8). One row per released receipt PER TERRITORY (unique on
 * (escrow_ledger_id, territory_code)): the per-leg routing detail computed
 * from that territory's own money and its own paid state, so the shortfall
 * carry stays per-territory and no pooled allocation can pass the firewall.
 * Lifecycle mirrors the parent record: inserted 'routed' before the money
 * moves, flipped 'applied' on release success, deleted when the release
 * refuses. The CAMA firewall state rides the row: the flag as honored, and
 * the cross-territorial applications when the override fired (null = none —
 * the default-deny shape).
 */
export type FilmTerritoryDistributionRecord = {
  id: string;
  film_id: string;
  escrow_ledger_id: string;
  territory_code: string;
  status: FilmTerritoryDistributionStatus;
  /** The First Dollar Gross bypass this territory's envelope took, integer cents. */
  fdg_bypass_cents: number;
  /** The per-leg routing detail (the router's leg outcomes), stored jsonb. */
  legs: import("@/modules/waterfall/engine").WaterfallLegRouting[];
  /** The per-tier totals this envelope routed, stored jsonb. */
  tier_allocations: import("@/modules/waterfall/engine").WaterfallTierAllocation[];
  /** The honest per-territory carry after this routing, integer cents. */
  unpaid_total_cents: number;
  /** The CAMA cross-collateralization flag as honored at routing (default false). */
  cross_collateralization_permitted: boolean;
  /** The cross-territorial applications when the CAMA override fired; null = none. */
  cross_applications: FilmTerritoryCrossApplication[] | null;
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
  splits: import("@/lib/don/types").SplitPartyInput[];
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
  accruals: import("@/lib/don/types").AllocatedSplit[];
  /** The integer-cent dust the sweep routed to the variance account. */
  company_dust_cents: number;
  created_at: string;
};

export type PodcastMilestoneKind = "downloads" | "reach";

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

export type PodcastGuestBonusAccrualStatus = "accrued" | "posted";

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

// --- Gaming engine-royalty accumulator + item splits (PR 12, migration 0018) ---

/**
 * One Epic-family gross contribution to the per-product annual engine-
 * royalty accumulator — append-only, UNIQUE on event_id (the queue event
 * that contributed). The accumulator's state is the DERIVED sum of these
 * rows (sumGamingEngineRoyaltyGross), never a mutable counter: a replayed
 * ingest re-derives the same event_id and the UNIQUE constraint makes the
 * contribution a counted no-op, so the $1M threshold can never be crossed
 * twice by replayed gross. The recorded engine_royalty_micros is the line's
 * own royalty AT CONTRIBUTION TIME — a replay that re-derives the queue row
 * reuses the recorded value instead of recomputing against moved state.
 * `platform` is the recon worker's GamingPlatform union (string here — the
 * worker is the validated writer; the record column is text).
 */
export type GamingEngineRoyaltyEventRecord = {
  id: string;
  /** UNIQUE — the contributing queue event; one contribution, ever. */
  event_id: string;
  /** 'epic_games_store' | 'unreal_marketplace' — validated at the writer. */
  platform: string;
  /** The Epic product (App/Project ID) the accumulator is scoped to. */
  product_id: string;
  /** The accumulator's UTC annual year — the $1M threshold's bucket. */
  annual_year: number;
  /** The line's gross contribution, fixed-point micros as text. */
  gross_micros: string;
  /** The line's own engine royalty at contribution time, micros as text. */
  engine_royalty_micros: string;
  created_at: string;
};

/**
 * One registered per-item split schedule — the gaming lane's per-contract
 * routing (the founder gaming directive: a primary sale pays studio lead
 * 50 / 3D modeler 30 / audio designer 20, configurable per contract). One
 * row per item (`gaming_item_split_schedules`, migration 0018); the engine
 * module (src/workers/recon/gamingSplits.ts) is the registration gate —
 * rows are what passed it, keyed one schedule per item, monotonic version.
 */
export type GamingItemSplitScheduleRecord = {
  item_id: string;
  /** The vault asset the item maps to (matched_cbt_code), when known. */
  asset_cbt_code: string | null;
  /**
   * The per-payee routing of a primary sale's net. share_bps must sum to
   * EXACTLY 10000 (100.0000%) — validated at registration and re-validated
   * at every accrual.
   */
  splits: import("@/lib/don/types").SplitPartyInput[];
  /**
   * The original-creator payee for the secondary-resale royalty (the 5-10%
   * platform creator fee). Required when the item's contract enables
   * secondary resale — a secondary line against a schedule without one
   * fails the accrual, never silently unattributed money.
   */
  resale_royalty_payee_id: string | null;
  /** Monotonic registration version — bumped on every accepted re-registration. */
  version: number;
  created_at: string;
  updated_at: string;
};

/**
 * One per-item split payout — the routing-decision record for ONE holding
 * credit (unique on source_event_id: the queue event that funded it, the
 * same id the holding credit carries as its journal ref). Written once per
 * funding event, ever — a replayed ingest re-derives the same
 * source_event_id and the UNIQUE constraint turns the replay into a counted
 * no-op. On a secondary sale the recorded resale_royalty_cents routed to
 * resale_royalty_payee_id OFF THE TOP and `accruals` route the remainder —
 * allocations plus company dust equal the source amount exactly (the locked
 * Don invariant). Integer cents; never a float.
 */
export type GamingSplitPayoutRecord = {
  id: string;
  item_id: string;
  /** UNIQUE — the funding queue event; one payout routing, ever. */
  source_event_id: string;
  /** The line's creator net that was routed, integer cents. */
  source_amount_cents: number;
  /** The original-creator royalty routed off the top on secondary sales. */
  resale_royalty_payee_id: string | null;
  /** The royalty's integer cents (0 on primary sales). */
  resale_royalty_cents: number;
  /** The schedule version the accrual used. */
  split_version: number;
  /** The per-payee integer-cent accruals (floor shares, dust swept out). */
  accruals: import("@/lib/don/types").AllocatedSplit[];
  /** The integer-cent dust the sweep routed to the variance account. */
  company_dust_cents: number;
  created_at: string;
};

// --- Gaming cashout states: DevEx conversion logs + studio KYC (PR 13, migration 0019) ---

/**
 * One durable virtual-currency conversion record — the DevEx conversion's
 * auditable facts (the founder's rate-logging rule, made durable). The
 * match_queue row carries the conversion cells at write time (PR 12); the
 * CONVERSION LOG is the ledger-grade record that holds until the platform's
 * fiat settlement completes: the release path reads a batch's logs and
 * refuses while any is still pending. UNIQUE on event_id — the
 * content-derived `gaming:devex:` id (per funding line) — so a replayed
 * ingest re-derives the same id and the constraint turns the insert into a
 * counted no-op. Integer cents; never a float.
 */
export type GamingDevexConversionLogRecord = {
  id: string;
  /** UNIQUE — the conversion log's own content-derived id (`gaming:devex:<line event id>`); one log per funding line, ever. */
  event_id: string;
  /** The funding queue event — match_queue.event_id (0007); the FK target. */
  line_event_id: string;
  /** The platform whose DevEx program converted (the recon worker's validated writer). */
  platform: string;
  /** The virtual-currency denomination ('Robux' on Roblox DevEx rows). */
  denomination: string;
  /** Exact virtual amount as decimal text — never a float. */
  virtual_amount: string;
  /** The applied fiat-per-virtual-unit exchange rate, exact decimal text. */
  exchange_rate: string;
  /** The conversion's fiat net in whole integer cents (floored from the exact micros product — sub-cent residue never rounds up). */
  fiat_net_cents: number;
  /** The platform payout batch the conversion rides — the cross-reference and settlement key. */
  settlement_batch_ref: string;
  /** 'pending_fiat_settlement' until the batch's fiat settlement completes, then 'fiat_settled'. */
  status: "pending_fiat_settlement" | "fiat_settled";
  /** When the batch's fiat settlement landed (null while pending). */
  settled_at: string | null;
  created_at: string;
};

/** One named studio team member's identity check (gaming vertical). */
export type GamingStudioTeamMember = {
  /** The member's identity key — the payout gate's team_member_checks member_ref. */
  member_ref: string;
  /** The member's role on the studio roster ('3d_artist', 'developer', 'sound_designer', ...). */
  role: string;
  /** Whether the member's identity check passed — false/unknown refuses at the gate. */
  identity_check_passed: boolean;
};

/**
 * One studio's KYC verification state — the STUDIO-LEVEL compliance record
 * the gaming payout gate reads: the studio's own KYC status PLUS every
 * named team member's identity check (3D artist, developer, sound
 * designer, ...). One row per studio payee (the Don store's sovereign
 * identity); a re-verification replaces the row. The gate refuses on an
 * absent record — no state is never assumed verified.
 */
export type GamingStudioKycRecord = {
  id: string;
  /** UNIQUE — the studio's payee id (the Don store's sovereign identity). */
  studio_payee_id: string;
  /** The studio's own KYC status — the Don KycStatus union. */
  studio_kyc_status: import("@/lib/don/types").KycStatus;
  /** The named roster — every member the studio-level verification covers. */
  team_members: GamingStudioTeamMember[];
  /** The verified studio contract's reference, when known (provenance). */
  contract_ref: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// VTuber agency licensing holdbacks + tax withholding verification
// (migration 0020, PR 15). The LEDGER state itself — kind and status
// 'avatar_ip_licensing_holdback' — rides the existing ledger_transactions
// free-text columns (the PR 7/PR 9/PR 13/PR 14 precedent; no migration).
// ---------------------------------------------------------------------------

/** The verification state's vocabulary — pending/failed refuse at the gate. */
export type VtuberTaxWithholdingVerificationState =
  "pending" | "verified" | "failed";

/**
 * One payee's tax-withholding verification for one tax year — the durable
 * state behind the livestream payout gate's `tax_withholding_verified`
 * read. One row per (payee_id, tax_year); a re-verification replaces the
 * row. Wired to the withholding machinery of record: a 'verified' state is
 * only writable when the payee's creator tax profile (the fields
 * applyWithholding maintains) shows tin_verified AND w9_on_file.
 */
export type VtuberTaxWithholdingVerificationRecord = {
  id: string;
  /** The payee's sovereign identity — UNIQUE with tax_year. */
  payee_id: string;
  /** The tax year the verification covers. */
  tax_year: number;
  /** 'verified' is the only passing state; pending/failed refuse at the gate. */
  state: VtuberTaxWithholdingVerificationState;
  /** The payee's TIN status of record (the creator tax profile's field). */
  tin_verified: boolean;
  /** The payee's W-9/W-8 status of record (the creator tax profile's field). */
  w9_on_file: boolean;
  /** The withholding evidence the verification cites (required for 'verified'). */
  evidence_ref: string | null;
  /** When the verification reached its state (null while pending). */
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * One tech setup amortization schedule — the agency's advanced 3D model
 * rigging / tech setup cost, recovered as deterministic integer-cent line
 * deductions across the releases. The schedule row is the immutable
 * contract; the consumption state lives in the LINES (append-only — the
 * PR 12 accumulator's insert-as-lock discipline), never in a mutable
 * counter, so a concurrent consume is a unique violation on
 * (schedule_ref, line_index), never a lost update.
 */
export type VtuberTechSetupAmortizationScheduleRecord = {
  id: string;
  /** UNIQUE — the contract's own schedule reference (provenance). */
  schedule_ref: string;
  /** The agency payee the deductions route to (the advanced cost's owner). */
  agency_payee_id: string;
  /** What the schedule amortizes ('3D model rigging', 'tech setup', ...). */
  description: string;
  /** The advanced cost, integer cents — conserved exactly across the lines. */
  total_cost_cents: number;
  /** The number of integer-cent line deductions (>= 1). */
  amortization_periods: number;
  created_at: string;
};

/**
 * One consumed amortization line — APPEND-ONLY, unique per
 * (schedule_ref, line_index). The line's cents are computed by the pure
 * schedule math at consume time: floor(total/periods) per line, the LAST
 * line absorbing the integer-cent remainder. Sum of lines === total cost,
 * always.
 */
export type VtuberTechSetupAmortizationLineRecord = {
  id: string;
  /** The schedule the line consumes — FK to schedules.schedule_ref (0020). */
  schedule_ref: string;
  /** Zero-based line position — UNIQUE with schedule_ref (the consume arbiter). */
  line_index: number;
  /** The line's deterministic integer-cent deduction. */
  line_cents: number;
  /** When the line was consumed (the release that deducted it). */
  deducted_at: string;
  created_at: string;
};

/**
 * One per-edge fractional royalty contract over the parent_asset_id
 * dependency tree (migration 0021) — the derivative cascade's input
 * registry. When the child asset sells (first sale or secondary
 * marketplace resale), the allocator's depth-first walk pays this edge's
 * upstream creator floor(royalty_bps * sale_gross / 10000) integer cents
 * BEFORE the downstream modder's net is computed. UNIQUE on
 * (asset_id, parent_asset_id, upstream_creator_payee_id): a duplicate
 * registration throws the unique violation; distinct payees may hold
 * distinct fractions on one edge (co-holders).
 */
export type DerivativeRoyaltyEdgeRecord = {
  id: string;
  /** The derivative (child) asset the contract hangs off — the walk's start. */
  asset_id: string;
  /** The upstream asset this derivative builds on (mesh, texture, script, ...). */
  parent_asset_id: string;
  /** The upstream creator the edge pays — the sovereign payee identity. */
  upstream_creator_payee_id: string;
  /** The payee's display name of record at registration (the contract row carries it). */
  upstream_creator_payee_name: string;
  /** The edge's fraction of a downstream sale gross, basis points (0 < bps <= 10000). */
  royalty_bps: number;
  created_at: string;
};

/**
 * One clearance agreement of record (migration 0022) — the music sample
 * cascade's input registry. The child work licenses an upstream composition
 * on ONE side of the rights separation (rights_type 'master' = master sample,
 * 'publishing' = interpolation); a line's cascade fires only the edges
 * matching the line's own rights_type. When the work's line releases, the
 * allocator reserves floor(license_bps * line_gross / 10000) integer cents
 * for this edge's rights holder BEFORE the net artist/producer split math.
 * UNIQUE on (work_id, parent_composition_id, rights_holder_payee_id,
 * rights_type): a duplicate registration throws the unique violation; the
 * same (work, parent) pair may be licensed on both sides of the separation.
 */
export type SampleClearanceEdgeRecord = {
  id: string;
  /** The downstream work using the sample/interpolation — the walk's start. */
  work_id: string;
  /** The upstream composition this work samples or interpolates. */
  parent_composition_id: string;
  /** Which side of the rights separation this edge belongs to. */
  rights_type: "master" | "publishing";
  /** The rights holder the edge pays — the sovereign payee identity. */
  rights_holder_payee_id: string;
  /** The payee's display name of record at registration. */
  rights_holder_payee_name: string;
  /** The edge's fraction of the line gross, basis points (0 < bps <= 10000). */
  license_bps: number;
  /** The clearance agreement the percentage was extracted from (of record). */
  clearance_agreement_ref: string;
  created_at: string;
};

/**
 * The publishers of record per composition (migration 0022) — the statutory
 * cover mechanical's input registry. A cover version routes the statutory
 * mechanical pool to these publishers directly, by share, BEFORE the
 * recording artist. Shares are the publishers' splits of the mechanical pool
 * and must sum to exactly 10000 per composition — a cross-row sum no per-row
 * constraint can express, so the planner enforces it fail-closed. UNIQUE on
 * (composition_id, publisher_payee_id): a duplicate registration throws the
 * unique violation.
 */
export type CompositionPublisherRecord = {
  id: string;
  /** The composition the publisher holds a share of (cbt_assets identity). */
  composition_id: string;
  /** The publisher of record — the sovereign payee identity. */
  publisher_payee_id: string;
  /** The payee's display name of record at registration. */
  publisher_payee_name: string;
  /** The publisher's share of the statutory mechanical pool, basis points. */
  share_bps: number;
  created_at: string;
};

/**
 * One studio split role of record (migration 0024) — the webtoon production
 * split schedule's input registry. The series' net (post-translation)
 * divides across the three role groups, each inside its founder band:
 * original creator & storywriter 30-40%, line artist & inker 20-30%,
 * colorist & background artist 10-15%. One row per (series, group, payee):
 * a group may carry several payees — the group's band constrains the
 * group's TOTAL. UNIQUE on (series_id, role_group, payee_id).
 */
export type WebtoonStudioSplitRoleRecord = {
  id: string;
  /** The series the schedule pays — a cbt_assets identity. */
  series_id: string;
  /** Which founder band this role rides. */
  role_group: "original_creator_storywriter" | "line_artist_inker" | "colorist_background";
  /** The payee the group's allocation routes to — the sovereign identity. */
  payee_id: string;
  /** The payee's display name of record at registration. */
  payee_name: string;
  /** This payee's share of the studio pool, basis points (0 < bps <= 10000); the group's total is Σ its members' bps, band-checked. */
  share_bps: number;
  /** The production contract the split was extracted from (of record). */
  contract_ref: string;
  created_at: string;
};

/**
 * The localization contract of record (migration 0024) — one per
 * (series, language) feed. Keys the per-language cascade: the localizer is
 * paid FIRST (flat fee per chapter or fractional rev share of the feed
 * gross), then the studio splits, then the primary author's net. UNIQUE on
 * (series_id, language_code): one localizer of record per language feed.
 */
export type WebtoonLocalizationContractRecord = {
  id: string;
  /** The series whose foreign feed this contract governs. */
  series_id: string;
  /** The language feed's code (the match_queue.language_code vocabulary). */
  language_code: string;
  /** The localizer of record — the sovereign payee identity. */
  localizer_payee_id: string;
  /** The payee's display name of record at registration. */
  localizer_payee_name: string;
  /** `flat_fee` pays per_chapter_flat_fee_cents; `rev_share` pays rev_share_bps. */
  fee_mode: "flat_fee" | "rev_share";
  /** The per-chapter flat fee, integer cents — flat_fee mode only. */
  per_chapter_flat_fee_cents: number;
  /** The feed's revenue share, basis points — rev_share mode only. */
  rev_share_bps: number;
  /** The localization agreement the terms were extracted from (of record). */
  contract_ref: string;
  created_at: string;
};

/**
 * The localization cost amortization schedule of record (migration 0024) —
 * the immutable contract. One per (series, language) feed; the consumed
 * LINES (webtoon_localization_cost_lines) are append-only and unique per
 * (schedule_ref, line_index) — the VTuber tech-setup amortization
 * discipline. A foreign feed's royalty releases only as the schedule's
 * deterministic lines amortize.
 */
export type WebtoonLocalizationCostScheduleRecord = {
  id: string;
  /** The business key the release resolves the schedule by. */
  schedule_ref: string;
  series_id: string;
  language_code: string;
  /** The total localization cost, integer cents. */
  total_cost_cents: number;
  /** How many deterministic amortization periods the cost divides into. */
  amortization_periods: number;
  /** The localization invoice/agreement of record. */
  cost_agreement_ref: string;
  created_at: string;
};

/**
 * One consumed amortization line (migration 0024) — the append-only
 * consumption ledger. UNIQUE per (schedule_ref, line_index): the
 * insert-as-lock guard against a concurrent release consuming one period
 * twice.
 */
export type WebtoonLocalizationCostLineRecord = {
  id: string;
  schedule_ref: string;
  /** The zero-based period this line consumes. */
  line_index: number;
  /** The integer cents this line recovered. */
  amount_cents: number;
  /** The escrow release that consumed the line. */
  released_in_ledger_id: string;
  created_at: string;
};

/**
 * The recoupment pool class — the ISOLATION rule's two sides (PR 20). A
 * print advance recoups ONLY from print-edition revenue; digital chapter
 * coin unlock revenue recoups ONLY its own pool. Cross-class application is
 * refused — the film cross-collateralization firewall's per-asset form.
 */
export type WebtoonRecoupmentPoolClass = "print_advance" | "digital_coin_unlock";

/**
 * One recoupment pool of record (migration 0024) — one advance per
 * (series, class). The pool is a LIABILITY: advance_cents is what the
 * platform fronted, recouped_cents the running recovery, status flips to
 * 'recouped' when the recovery completes.
 */
export type WebtoonRecoupmentPoolRecord = {
  id: string;
  series_id: string;
  pool_class: WebtoonRecoupmentPoolClass;
  /** The fronted advance, integer cents. */
  advance_cents: number;
  /** The running recovery, integer cents (<= advance_cents). */
  recouped_cents: number;
  currency: string;
  /** 'active' until the advance fully recoups, then 'recouped'. */
  status: "active" | "recouped";
  /** The print edition / coin program agreement of record. */
  advance_agreement_ref: string;
  created_at: string;
  updated_at: string;
};

/**
 * One recoupment application (migration 0024) — the append-only recovery
 * ledger. UNIQUE per (pool_id, source_event_id): a replayed application is
 * the unique violation, never a double recovery. UNIQUE per
 * (pool_id, recouped_before_cents): the POSITION lock — the insert-as-lock
 * arbiter (the PR 12 accumulator / PR 99 amortization discipline) — so two
 * concurrent applications of one pool compute the same running position and
 * exactly one wins it; the loser re-derives from the append-only truth.
 */
export type WebtoonRecoupmentApplicationRecord = {
  id: string;
  pool_id: string;
  pool_class: WebtoonRecoupmentPoolClass;
  /** The revenue feed's content-derived event id — the replay guard. */
  source_event_id: string;
  /** The pool's recouped_cents the instant before this application — the position. */
  recouped_before_cents: number;
  /** The integer cents of revenue applied this application. */
  applied_cents: number;
  /** The integer cents of the pool still open after this application. */
  remaining_cents: number;
  created_at: string;
};

// --- Book editorial split ledger (PR 26, migration 0030) -------------------

/**
 * The stream classes a book title's advances recoup through (the founder
 * publishing directive) — the isolation firewall's vocabulary: a royalty
 * event recoups ONLY its own class, exactly the webtoon print/coin rule;
 * audiobook_production_unrecouped is its own class, never
 * cross-collateralized from e-book or print revenue.
 */
export const BOOK_RECOUPMENT_POOL_CLASSES = [
  'ebook_advance',
  'print_advance',
  'audiobook_production_unrecouped',
] as const;
export type BookRecoupmentPoolClass = (typeof BOOK_RECOUPMENT_POOL_CLASSES)[number];

export function isBookRecoupmentPoolClass(value: string): value is BookRecoupmentPoolClass {
  return (BOOK_RECOUPMENT_POOL_CLASSES as readonly string[]).includes(value);
}

/**
 * One sequential advance recoupment pool of record per (isbn, class,
 * sequence_no) (migration 0030) — the co-author/ghostwriter sequence: a
 * title's pools fill in sequence_no order, 100% of the stream's net
 * royalties flowing until each clears. The append-only application rows
 * are the truth; recouped_cents/status are the derived read (the webtoon
 * pool's discipline).
 */
export type BookRecoupmentPoolRecord = {
  id: string;
  /** The title identity the pools key on — the canonical ISBN-13. */
  isbn: string;
  pool_class: BookRecoupmentPoolClass;
  /** The recoupment order (1 = first). The sequence is the co-author /
   * ghostwriter contract's order of record. */
  sequence_no: number;
  /** The fronted advance, integer cents. */
  advance_cents: number;
  /** The running recovery, integer cents (<= advance_cents). */
  recouped_cents: number;
  currency: string;
  /** 'active' until the advance fully recoups, then 'recouped'. */
  status: 'active' | 'recouped';
  /** The advance agreement of record. */
  advance_agreement_ref: string;
  created_at: string;
  updated_at: string;
};

/**
 * One book recoupment application (migration 0030) — the append-only
 * recovery ledger. UNIQUE per (pool_id, source_event_id): a replayed
 * application is the unique violation, never a double recovery. UNIQUE per
 * (pool_id, recouped_before_cents): the POSITION lock — the insert-as-lock
 * arbiter (PR 12/PR 99/webtoon discipline) — so two concurrent
 * applications of one pool compute the same running position and exactly
 * one wins it; the loser re-derives from the append-only truth.
 */
export type BookRecoupmentApplicationRecord = {
  id: string;
  pool_id: string;
  pool_class: BookRecoupmentPoolClass;
  isbn: string;
  /** The revenue feed's content-derived event id — the replay guard. */
  source_event_id: string;
  /** The pool's recouped_cents the instant before this application. */
  recouped_before_cents: number;
  /** The integer cents of revenue applied this application. */
  applied_cents: number;
  /** The integer cents of the pool still open after this application. */
  remaining_cents: number;
  created_at: string;
};

/**
 * The editorial cut contributor roles the directive names — the magazine
 * roster's creative credits plus the book side's contributing authors.
 * The role is descriptive metadata on the cut (the money keys on the
 * payee and the mode), recorded for the audit trail.
 */
export const BOOK_EDITORIAL_CONTRIBUTOR_ROLES = [
  'cover_artist',
  'featured_columnist',
  'senior_editor',
  'layout_designer',
  'contributing_author',
] as const;
export type BookEditorialContributorRole =
  (typeof BOOK_EDITORIAL_CONTRIBUTOR_ROLES)[number];

export function isBookEditorialContributorRole(
  value: string,
): value is BookEditorialContributorRole {
  return (BOOK_EDITORIAL_CONTRIBUTOR_ROLES as readonly string[]).includes(value);
}

/**
 * The cut modes: flat per-issue (the contracted fee, once per issue —
 * cover artists and layout designers), percentage (bps of the funding
 * base — subscription cuts and post-advance standard splits), and pro-rata
 * (anthology contributors by page or word count).
 */
export const BOOK_EDITORIAL_SPLIT_MODES = [
  'flat_per_issue',
  'percentage',
  'pro_rata',
] as const;
export type BookEditorialSplitMode = (typeof BOOK_EDITORIAL_SPLIT_MODES)[number];

/** The anthology pro-rata bases the directive pins. */
export const BOOK_EDITORIAL_PRO_RATA_BASES = ['page_count', 'word_count'] as const;
export type BookEditorialProRataBasis = (typeof BOOK_EDITORIAL_PRO_RATA_BASES)[number];

/**
 * One contributor's cut of record on a schedule. Exactly one money field
 * is non-null per contributor — the mode's own input (validated at
 * registration; the cascade refuses a schedule that mixes modes where the
 * scope forbids it).
 */
export type BookEditorialContributorSpec = {
  payee_id: string;
  payee_name: string;
  role: BookEditorialContributorRole;
  mode: BookEditorialSplitMode;
  /** flat_per_issue: the contracted flat cents per issue. */
  flat_cents: number | null;
  /** percentage: whole basis points of the funding base. */
  percentage_bps: number | null;
  /** pro_rata: the contributor's page or word count (positive). */
  pro_rata_count: number | null;
};

/**
 * The editorial split schedule of record (migration 0030) — one per
 * title_key. Book scope keys the title's ISBN (post-advance standard
 * splits in 'percentage' mode, or an anthology's pro-rata in 'pro_rata'
 * mode with its basis); magazine_issue scope keys `magazine:{issueId}` and
 * carries the issue's roster with per-contributor modes (the directive's
 * configurable flat-per-issue vs percentage cuts).
 */
export type BookEditorialSplitScheduleRecord = {
  id: string;
  title_key: string;
  scope: 'book' | 'magazine_issue';
  mode: BookEditorialSplitMode;
  /** pro_rata mode's basis; null otherwise. */
  pro_rata_basis: BookEditorialProRataBasis | null;
  contributors: BookEditorialContributorSpec[];
  /** The schedule's revision — a re-registration increments it; accrued
   * cuts keep their version's event ids (history, never re-cut). */
  version: number;
  created_at: string;
  updated_at: string;
};

/** One payee's designated share on an accrual — the release path's input. */
export type BookEditorialSplitAllocation = {
  payee_id: string;
  payee_name: string;
  share_cents: number;
};

/**
 * One executed editorial split (migration 0030) — the append-only accrual
 * ledger. UNIQUE per source_event_id: a replayed split is the unique
 * violation, never a double accrual. The accrual DESIGNATES the routing;
 * the money moves through the standing release machinery (the payout
 * gates) — the accrual row is the gate's verified input.
 */
export type BookEditorialSplitAccrualRecord = {
  id: string;
  schedule_id: string;
  title_key: string;
  scope: 'book' | 'magazine_issue';
  /** The funding row's event id, or the flat cut's per-issue identity
   * (`book:magazine_flat:{issueId}:{version}`) — the once-only guard. */
  source_event_id: string;
  /** The split's funding base, integer cents (0 for flat cuts). */
  basis_cents: number;
  allocations: BookEditorialSplitAllocation[];
  /** The visible floor residue — never rounded into a contributor's credit. */
  dust_cents: number;
  created_at: string;
};

// --- Art market waterfalls (PR 28, migration 0032) ---------------------------

/**
 * The fabrication recoupment pool classes (PR 28, the founder art
 * directive) — the isolation firewall's art vocabulary: a print shop sale
 * recoups ONLY print_edition_fabrication pools (master printmaker and
 * lithographer costs); a sculpture sale recoups ONLY sculpture_fabrication
 * pools (bronze foundry and 3D printing bills). Museum licensing money and
 * ARR resales touch neither — the books pool-class rule, applied to
 * fabrication debts.
 */
export const ART_RECOUPMENT_POOL_CLASSES = [
  "print_edition_fabrication",
  "sculpture_fabrication",
] as const;
export type ArtRecoupmentPoolClass = (typeof ART_RECOUPMENT_POOL_CLASSES)[number];

export function isArtRecoupmentPoolClass(value: string): value is ArtRecoupmentPoolClass {
  return (ART_RECOUPMENT_POOL_CLASSES as readonly string[]).includes(value);
}

/**
 * The creditor roles a fabrication debt can name — the costs that recoup
 * BEFORE any split exists: the print edition's master printmaker and
 * lithographer, the sculpture's bronze foundry and 3D printing bills.
 */
export const ART_CREDITOR_ROLES = [
  "master_printmaker",
  "lithographer",
  "bronze_foundry",
  "three_d_printing",
] as const;
export type ArtCreditorRole = (typeof ART_CREDITOR_ROLES)[number];

export function isArtCreditorRole(value: string): value is ArtCreditorRole {
  return (ART_CREDITOR_ROLES as readonly string[]).includes(value);
}

/**
 * One sequential fabrication recoupment pool of record per (scope_key,
 * pool_class, sequence_no) (migration 0032) — a print edition's or a
 * sculpture's registered fabrication debts, keyed on the edition or
 * artwork scope: the pools fill in sequence_no order, 100% of the sale's
 * net flowing until each clears. The append-only application rows are the
 * truth; recouped_cents/status are the derived read (the books pool's
 * discipline).
 */
export type ArtRecoupmentPoolRecord = {
  id: string;
  /** The waterfall scope key — `edition:{editionId}` for print editions,
   * `sculpture:{artworkId}` for sculpture fabrications. */
  scope_key: string;
  pool_class: ArtRecoupmentPoolClass;
  /** The recoupment order (1 = first). The sequence is the fabrication
   * contract's order of record. */
  sequence_no: number;
  /** The fronted fabrication debt, integer cents. */
  debt_cents: number;
  /** The running recovery, integer cents (<= debt_cents). */
  recouped_cents: number;
  currency: string;
  /** 'active' until the debt fully recoups, then 'recouped'. */
  status: 'active' | 'recouped';
  /** The creditor the debt is owed to. */
  creditor_role: ArtCreditorRole;
  creditor_payee_id: string;
  creditor_payee_name: string;
  /** The fabrication agreement of record. */
  agreement_ref: string;
  created_at: string;
  updated_at: string;
};

/**
 * One art recoupment application (migration 0032) — the append-only
 * recovery ledger. UNIQUE per (pool_id, source_event_id): a replayed
 * application is the unique violation, never a double recovery. UNIQUE per
 * (pool_id, recouped_before_cents): the POSITION lock — the insert-as-lock
 * arbiter (the books/webtoon discipline) — so two concurrent applications
 * of one pool compute the same running position and exactly one wins it;
 * the loser re-derives from the append-only truth.
 */
export type ArtRecoupmentApplicationRecord = {
  id: string;
  pool_id: string;
  pool_class: ArtRecoupmentPoolClass;
  scope_key: string;
  /** The revenue feed's content-derived event id — the replay guard. */
  source_event_id: string;
  /** The pool's recouped_cents the instant before this application. */
  recouped_before_cents: number;
  /** The integer cents of revenue applied this application. */
  applied_cents: number;
  /** The integer cents of the pool still open after this application. */
  remaining_cents: number;
  created_at: string;
};

/**
 * The post-recoupment split contributor roles the directive names — the
 * founder's example cut (50% artist / 30% gallery / 20% master
 * printmaker) and the sculpture releases (studio assistants and
 * co-creators). The role is descriptive metadata on the cut (the money
 * keys on the payee), recorded for the audit trail.
 */
export const ART_CONTRIBUTOR_ROLES = [
  "artist",
  "gallery",
  "master_printmaker",
  "lithographer",
  "bronze_foundry",
  "three_d_printing",
  "studio_assistant",
  "co_creator",
] as const;
export type ArtContributorRole = (typeof ART_CONTRIBUTOR_ROLES)[number];

export function isArtContributorRole(value: string): value is ArtContributorRole {
  return (ART_CONTRIBUTOR_ROLES as readonly string[]).includes(value);
}

/**
 * The art split schedule's scopes (migration 0032) — percentage mode only
 * (the founder's example cut is a percentage cut; the books pro-rata
 * anthology modes have no art analogue in the directive).
 */
export const ART_SPLIT_SCHEDULE_SCOPES = [
  "print_edition",
  "sculpture_fabrication",
] as const;
export type ArtSplitScheduleScope = (typeof ART_SPLIT_SCHEDULE_SCOPES)[number];

/**
 * One contributor's cut of record on an art split schedule — percentage
 * mode only: whole basis points of the post-recoupment net.
 */
export type ArtSplitContributorSpec = {
  payee_id: string;
  payee_name: string;
  role: ArtContributorRole;
  /** Whole basis points of the post-recoupment net (1..10000). */
  percentage_bps: number;
};

/**
 * The art split schedule of record (migration 0032) — one per scope_key.
 * The print-edition example cut (artist 50 / gallery 30 / master
 * printmaker 20) and the sculpture releases (studio assistants,
 * co-creators) register here; the waterfall applies them ONLY to the
 * excess after every fabrication pool has recouped.
 */
export type ArtSplitScheduleRecord = {
  id: string;
  scope_key: string;
  scope: ArtSplitScheduleScope;
  contributors: ArtSplitContributorSpec[];
  /** The schedule's revision — a re-registration increments it; accrued
   * cuts keep their version's event ids (history, never re-cut). */
  version: number;
  created_at: string;
  updated_at: string;
};

/** One payee's designated share on an art split accrual. */
export type ArtSplitAllocation = {
  payee_id: string;
  payee_name: string;
  share_cents: number;
};

/**
 * One executed art split (migration 0032) — the append-only accrual
 * ledger. UNIQUE per source_event_id: a replayed split is the unique
 * violation, never a double accrual. The accrual DESIGNATES the routing;
 * the money moves through the standing release machinery (the payout
 * gates) — the accrual row is the gate's verified input.
 */
export type ArtSplitAccrualRecord = {
  id: string;
  schedule_id: string;
  scope_key: string;
  scope: ArtSplitScheduleScope;
  /** The funding row's event id — the once-only guard. */
  source_event_id: string;
  /** The split's funding base, integer cents (the post-recoupment excess). */
  basis_cents: number;
  allocations: ArtSplitAllocation[];
  /** The visible floor residue — never rounded into a contributor's credit. */
  dust_cents: number;
  created_at: string;
};

/**
 * The copyright agencies the directive names — the museum licensing
 * collection-fee policy's vocabulary.
 */
export const ART_COPYRIGHT_AGENCIES = ["ars", "dacs"] as const;
export type ArtCopyrightAgency = (typeof ART_COPYRIGHT_AGENCIES)[number];

export function isArtCopyrightAgency(value: string): value is ArtCopyrightAgency {
  return (ART_COPYRIGHT_AGENCIES as readonly string[]).includes(value);
}

/**
 * The copyright agency collection-fee policy of record (migration 0032) —
 * one per agency_code, CONFIGURABLE inside the founder's 15–20% band
 * (validated at registration). The licensing row's applied fee is
 * validated against the same band at parse; the policy is the
 * administration's registered rate of record.
 */
export type ArtLicensingAgencyPolicyRecord = {
  id: string;
  agency_code: ArtCopyrightAgency;
  agency_name: string;
  /** The agency's collection fee, basis points of the license fee (1500..2000). */
  collection_fee_bps: number;
  created_at: string;
  updated_at: string;
};
// --- Estate succession + multi-heir splitting (PR 29, migration 0033) -------

/**
 * The legal certificate's validation states — the transition gate's
 * vocabulary. Only an explicit 'verified' state gates the receiving-entity
 * transition and the estate payout gate: 'pending' is a certificate of
 * record still in validation, 'rejected' a failed validation; absent,
 * pending, and rejected all refuse — fail-closed (the publishing
 * ip_rights vocabulary discipline).
 */
export const ESTATE_CERTIFICATE_VALIDATION_STATES = [
  "pending",
  "verified",
  "rejected",
] as const;
export type EstateCertificateValidationState =
  (typeof ESTATE_CERTIFICATE_VALIDATION_STATES)[number];

export function isEstateCertificateValidationState(
  value: string,
): value is EstateCertificateValidationState {
  return (ESTATE_CERTIFICATE_VALIDATION_STATES as readonly string[]).includes(value);
}

/**
 * The estate succession certificate of record (migration 0033) — the
 * verified legal fact that an artist's receiving entity transitions to the
 * named estate entity. UNIQUE per (artist_payee_id, certificate_ref): a
 * re-validation converges on the row (the newest state governs).
 * certificate_hash is the certificate document's SHA-256 hex digest — the
 * audit anchor; validation_state is the gate: only 'verified' transitions.
 */
export type EstateSuccessionCertificateRecord = {
  id: string;
  /** UNIQUE with certificate_ref — the artist whose succession this certifies. */
  artist_payee_id: string;
  /** UNIQUE with artist_payee_id — the legal certificate's reference of record. */
  certificate_ref: string;
  /** The certificate document's SHA-256 hex digest — the audit anchor. */
  certificate_hash: string;
  /** The receiving entity AFTER the transition (the estate/foundation payee). */
  estate_entity_payee_id: string;
  estate_entity_payee_name: string;
  /** The transition gate — only 'verified' transitions. */
  validation_state: EstateCertificateValidationState;
  /** The operator identity that recorded the validation. */
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The heir relationships a probate names — the founder's example split is
 * spouse / child / child; 'other' carries every other beneficiary a probate
 * of record designates. Descriptive metadata on the cut (the money keys on
 * the payee), recorded for the audit trail (the art contributor-role
 * discipline).
 */
export const ESTATE_HEIR_RELATIONSHIPS = [
  "spouse",
  "child",
  "other",
] as const;
export type EstateHeirRelationship = (typeof ESTATE_HEIR_RELATIONSHIPS)[number];

export function isEstateHeirRelationship(value: string): value is EstateHeirRelationship {
  return (ESTATE_HEIR_RELATIONSHIPS as readonly string[]).includes(value);
}

/**
 * One heir's probate share of record — the VERIFIED probate percentages
 * (whole basis points of the estate net, 1..10000). Configurable per
 * probate: the schedule of record is versioned, and accrued splits keep
 * their version's history — never re-cut.
 */
export type EstateHeirSpec = {
  heir_payee_id: string;
  heir_payee_name: string;
  relationship: EstateHeirRelationship;
  /** Whole basis points of the estate net (1..10000). */
  percentage_bps: number;
};

/**
 * The multi-heir fractional split of record (migration 0033) — one per
 * verified certificate, CONFIGURABLE per probate (e.g. spouse 50% /
 * child A 25% / child B 25%). heirs is the jsonb roster of EstateHeirSpec
 * rows read whole (the 0030/0032 contributors discipline); the roster's
 * Σ percentage_bps ≤ 10,000 is lane-validated at registration. UNIQUE per
 * certificate_id: a re-registration (a probate amendment) replaces the row
 * atomically and increments version — accrued splits keep their version's
 * history, never re-cut.
 */
export type EstateHeirScheduleRecord = {
  id: string;
  /** UNIQUE — the verified certificate the probate split hangs from. */
  certificate_id: string;
  heirs: EstateHeirSpec[];
  /** The schedule's revision — a re-registration increments it. */
  version: number;
  created_at: string;
  updated_at: string;
};

/**
 * One receiving-entity transition (migration 0033) — the append-only
 * handoff ledger: from the artist (the pre-transition receiving entity) to
 * the estate entity, gated on the certificate's verified state. The
 * transition INSERTS history; it never updates or deletes a ledger row —
 * the existing trail stays intact (the AI allocation-archive discipline:
 * append-only, audit-preserving). UNIQUE per (certificate_id,
 * source_event_id): a replayed transition is the unique violation, never a
 * double handoff. artwork_id + provenance_hash carry the funds' provenance
 * for audit.
 */
export type EstateSuccessionTransitionRecord = {
  id: string;
  certificate_id: string;
  /** The from-entity — the artist's payee. */
  artist_payee_id: string;
  /** The to-entity — the estate's payee. */
  estate_entity_payee_id: string;
  /** The funding event that drove this transition — the replay guard's key. */
  source_event_id: string;
  /** The artwork the funds relate to (null = an estate-wide handoff). */
  artwork_id: string | null;
  /** The funds' provenance hash, carried for audit. */
  provenance_hash: string | null;
  created_at: string;
};

/** One heir's designated share on an estate split accrual. */
export type EstateHeirAllocation = {
  heir_payee_id: string;
  heir_payee_name: string;
  relationship: EstateHeirRelationship;
  share_cents: number;
};

/**
 * One executed estate split (migration 0033) — the append-only multi-heir
 * accrual ledger. UNIQUE per (certificate_id, artwork_id, source_event_id):
 * a replayed split is the unique violation, never a double designation —
 * the provenance triple IS the once-only key. allocations is the jsonb
 * array of per-heir designated shares; dust_cents is the visible residue —
 * conservation: allocations + dust = basis, EXACT, nothing rounds up into
 * an heir's credit, and the dust routes to the platform variance payee
 * ('platform', never an heir — the locked Don dust discipline). The
 * accrual DESIGNATES the routing; the money moves through the standing
 * release machinery (the payout gates) — the accrual row is the gate's
 * verified input. artwork_id + provenance_hash carry the funds' provenance
 * on the line item for audit.
 */
export type EstateSplitAccrualRecord = {
  id: string;
  schedule_id: string;
  certificate_id: string;
  artist_payee_id: string;
  estate_entity_payee_id: string;
  /** The funding row's event id — part of the once-only provenance key. */
  source_event_id: string;
  /** The artwork the funds relate to — the provenance key. */
  artwork_id: string;
  /** The funds' provenance hash — carried on the line item for audit. */
  provenance_hash: string;
  /** The split's funding base, integer cents. */
  basis_cents: number;
  allocations: EstateHeirAllocation[];
  /** The visible residue routed to the platform variance payee. */
  dust_cents: number;
  created_at: string;
};

/**
 * The estate payout gate's stored states (migration 0033) — the persisted
 * fact the art vertical's compliance state resolves through (the AI
 * payout-gate states' per-payee pattern, migration 0029). UNIQUE per
 * payee_id: an upsert converges (the newest state governs the next
 * dispatch). The art payout gate reads these FAIL-CLOSED: an ABSENT record
 * returns null (the gate refuses with vertical_state_unknown), an
 * 'unknown' stored state maps to false (the gate refuses the specific
 * estate condition), and only 'verified' passes — nothing defaults to
 * allowing.
 */
export const ESTATE_PAYOUT_GATE_STATES = ["unknown", "verified"] as const;
export type EstatePayoutGateState = (typeof ESTATE_PAYOUT_GATE_STATES)[number];

export function isEstatePayoutGateState(value: string): value is EstatePayoutGateState {
  return (ESTATE_PAYOUT_GATE_STATES as readonly string[]).includes(value);
}

export type EstatePayoutGateStateRecord = {
  id: string;
  /** UNIQUE — the receiving payee whose estate payouts this gates (the
   * estate entity or an heir of record). */
  payee_id: string;
  estate_succession_state: EstatePayoutGateState;
  /** The verified certificate reference the state was recorded against. */
  certificate_ref: string | null;
  /** The operator identity that recorded the state. */
  verified_by: string | null;
  created_at: string;
  updated_at: string;
};

// --- AGBOR box office + theatrical recoupment (PR 30, migration 0034) -------

/**
 * The theatrical publisher of record — the Grand Rights collection entities
 * the founder brief names (authors and composers are paid THROUGH these;
 * the publisher's payee identity rides the deal). The vocabulary is closed
 * at registration.
 */
export const THEATRICAL_PUBLISHERS = ["concord", "mti", "rodgers_hammerstein"] as const;
export type TheatricalPublisherCode = (typeof THEATRICAL_PUBLISHERS)[number];

/** The two deal classes the box office waterfall walks. */
export const THEATRICAL_DEAL_CLASSES = ["comedy_guarantee", "theatrical_recoupment"] as const;
export type TheatricalDealClass = (typeof THEATRICAL_DEAL_CLASSES)[number];

/** The Grand Rights founder band — top-line 6% to 10% of AGBOR. */
export const GRAND_RIGHTS_MIN_BPS = 600;
export const GRAND_RIGHTS_MAX_BPS = 1000;

/**
 * The versioned box office deal of record per production scope (scope_key
 * `production:<id>`) — the tier table the waterfall walks. Comedy deals pin
 * the greater-of terms (flat guarantee vs percentage of the net box office
 * after venue expense recoupment); theatrical deals pin the capitalization
 * budget the investor recoupment tiers walk and the post-recoupment 50/50
 * pair. The Grand Rights rate is optional on both classes — present on
 * deals that license the underlying play/musical, absent otherwise; the
 * 6–10% band validates at registration. A re-registration increments
 * version; accrued designations keep their version's history, never re-cut.
 */
export type TheatricalProductionDealRecord = {
  id: string;
  /** UNIQUE — the production scope (`production:<production_id>`). */
  scope_key: string;
  deal_class: TheatricalDealClass;
  /** Grand Rights licensing rate, bps of AGBOR, inside the 6–10% band; null
   * when the production licenses no underlying theatrical work. Paired
   * non-null with the publisher identity columns. */
  grand_rights_rate_bps: number | null;
  publisher_code: TheatricalPublisherCode | null;
  publisher_payee_id: string | null;
  publisher_payee_name: string | null;
  /** The comedy class's guarantee recipient; null on theatrical deals. */
  artist_payee_id: string | null;
  artist_payee_name: string | null;
  /** The theatrical class's post-recoupment split pair; null on comedy. */
  producer_payee_id: string | null;
  producer_payee_name: string | null;
  investor_payee_id: string | null;
  investor_payee_name: string | null;
  /** Comedy: the flat guarantee floor, whole cents (> 0); null otherwise. */
  flat_guarantee_cents: number | null;
  /** Comedy: the percentage leg, bps of the net box office after venue
   * expense recoupment (0–10000); null otherwise. */
  guarantee_percentage_bps: number | null;
  /** Theatrical: the capitalization budget the investors recoup against,
   * whole cents (> 0); null on comedy. */
  capitalization_budget_cents: number | null;
  /** The running investor recoupment counter (never exceeds the budget). */
  recouped_cents: number;
  currency: string;
  /** The tier table's version — incremented on re-registration. */
  version: number;
  created_at: string;
  updated_at: string;
};

/** The role a designated share pays (the accrual allocation's discriminator). */
export const THEATRICAL_ALLOCATION_ROLES = [
  "theatrical_publisher",
  "artist",
  "producer",
  "investor",
] as const;
export type TheatricalAllocationRole = (typeof THEATRICAL_ALLOCATION_ROLES)[number];

/** One designated share on a split accrual — the per-payee payout leg. */
export type TheatricalSplitAllocation = {
  payee_id: string;
  payee_name: string;
  role: TheatricalAllocationRole;
  share_cents: number;
};

/**
 * One per-stop settlement sheet — the multi-city venue reconciliation row
 * keyed on (production_id, venue_id, show_date), the addendum 11 triple.
 * Every leg of the stop's math rides the row; the conservation checks pin
 * the AGBOR equation and the cap arithmetic exactly (migration 0034).
 */
export type TheatricalStopSettlementRecord = {
  id: string;
  production_id: string;
  venue_id: string;
  /** ISO YYYY-MM-DD — the reconciliation triple's date leg. */
  show_date: string;
  /** The funding queue row's event id — part of the once-only key. */
  source_event_id: string;
  /** The sender's settlement id of record (provenance). */
  settlement_id: string;
  sender_code: "axs" | "ticketmaster" | "eventbrite" | "venuepos";
  city: string;
  gbor_cents: number;
  sales_tax_cents: number;
  card_fees_cents: number;
  facility_fee_cents: number;
  ffe_fee_cents: number;
  group_discount_cents: number;
  /** GBOR minus the four deduction legs — exact to the cent. */
  agbor_cents: number;
  /** The Grand Rights deduction (0 when the deal registers no rate). */
  grand_rights_cents: number;
  venue_expense_cents: number;
  promoter_expense_cap_cents: number;
  /** min(venue_expense, promoter cap) — what recouped before the splits. */
  venue_expense_recouped_cents: number;
  /** The capped overage — the promoter's own money, never the tour's. */
  venue_expense_capped_cents: number;
  /** The total designated to the deal's payees this event. */
  deal_payout_cents: number;
  currency: string;
  created_at: string;
};

/**
 * One append-only investor recoupment application — 100% of a stop's net
 * profits applied to the capitalization budget. The position fields make
 * the ledger self-auditing: recouped_before + applied + remaining ties each
 * row to its neighbors without trusting any mutable counter.
 */
export type TheatricalRecoupmentApplicationRecord = {
  id: string;
  deal_id: string;
  scope_key: string;
  source_event_id: string;
  recouped_before_cents: number;
  applied_cents: number;
  remaining_cents: number;
  created_at: string;
};

/**
 * One append-only payout designation — the once-only allocation of a stop's
 * distributable net across the deal's payees (the Grand Rights publisher
 * leg, the artist's guarantee payout, the investor recoupment leg, the
 * post-recoupment 50/50 legs). dust_cents is the sub-cent residue of the
 * half splits; allocations + dust = basis, exact.
 */
export type TheatricalSplitAccrualRecord = {
  id: string;
  deal_id: string;
  scope_key: string;
  deal_class: TheatricalDealClass;
  source_event_id: string;
  basis_cents: number;
  allocations: TheatricalSplitAllocation[];
  dust_cents: number;
  created_at: string;
};

// --- IP adaptation optioning (PR 21, migration 0025) -----------------------

/**
 * The durable IP-rights verification state the publishing payout gate reads
 * for option-fee dispatch (the VTuber tax-withholding verification's
 * per-payee pattern, at work scope). One row per (payee_id, work_id); a
 * re-verification replaces the row atomically (the studio-KYC upsert
 * precedent). Only an explicit 'cleared' state passes the gate's
 * ip_rights_cleared condition — absent, pending, and failed all refuse,
 * fail-closed. A 'cleared' state carries mandatory evidence (the
 * clearance's provenance) and requires an option agreement of record for
 * the work — the machinery of record (the VTuber writer's precedent).
 */
export const PUBLISHING_IP_RIGHTS_STATES = ["pending", "cleared", "failed"] as const;
export type PublishingIpRightsState = (typeof PUBLISHING_IP_RIGHTS_STATES)[number];

export type PublishingIpRightsVerificationRecord = {
  id: string;
  /** The payee whose option-fee dispatch the gate evaluates. */
  payee_id: string;
  /** The optioned work the clearance covers. */
  work_id: string;
  /** The verification state — only 'cleared' passes the payout gate. */
  state: PublishingIpRightsState;
  /** The clearance's provenance of record — REQUIRED for 'cleared'. */
  evidence_ref: string | null;
  /** When the state reached 'cleared' (null until then). */
  cleared_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The IP option agreement of record (migration 0025) — one per work (a
 * webtoon series or novel optioned for film/TV/gaming). Names the original
 * author of record (the IP holder and the cascade's residual holder), the
 * agency of record, and the agency's commission in basis points OF THE
 * REMAINDER (after every author IP allocation is reserved — never of the
 * gross). Re-registering replaces the row atomically (upsert on work_id).
 */
export type IpOptionAgreementRecord = {
  id: string;
  /** The optioned work — the feed identity the option deal covers. */
  work_id: string;
  /** The original author of record — the IP holder; the residual holder. */
  author_payee_id: string;
  author_payee_name: string;
  /** The agency of record — the author's representation on the option deal. */
  agency_payee_id: string;
  agency_payee_name: string;
  /** The agency's commission, basis points of the REMAINDER (0..10000). */
  agency_commission_bps: number;
  /** The signed option agreement the terms were extracted from (of record). */
  option_deal_ref: string;
  created_at: string;
  updated_at: string;
};

/**
 * One author-side IP allocation (migration 0025) — a ring-fenced share of
 * the option fee reserved for one rights holder (the original author or a
 * co-holder/estate) BEFORE any agency commission exists. The table's
 * insertion order IS the reservation order (the deterministic author-first
 * sequence). UNIQUE on (work_id, payee_id); the work's FK guards the
 * agreement of record (text → text unique, type-matched).
 */
export type IpOptionAuthorAllocationRecord = {
  id: string;
  /** The optioned work — FK to the agreement of record. */
  work_id: string;
  payee_id: string;
  payee_name: string;
  /** This holder's ring-fenced IP allocation, basis points of the fee (1..10000). */
  allocation_bps: number;
  created_at: string;
};

// --- Merch COGS + the brand collaboration waterfall (PR 22, migration 0026) ---

/**
 * The merchandise production batch of record (migration 0026) — one row per
 * production run of one sku: the units the run produced and each unit's
 * production cost. The FIFO engine amortizes lots oldest-first
 * (created_at, then lot_ref); `cogs_per_unit_cents` is the lot's OWN
 * per-unit cost, because production batches of one sku price differently —
 * the amortization is keyed on sku_id AND cogs_per_unit. UNIQUE per
 * (sku_id, lot_ref): a re-registered lot is the unique violation, never a
 * double registration.
 */
export type MerchCogsLotRecord = {
  id: string;
  sku_id: string;
  lot_ref: string;
  units_produced: number;
  cogs_per_unit_cents: number;
  created_at: string;
};

/**
 * One FIFO COGS consumption (migration 0026) — the append-only amortization
 * truth, the webtoon localization amortization line's discipline (0024) at
 * unit scope. UNIQUE per (lot_id, source_event_id): a replayed fulfillment
 * event is the unique violation, never a double amortization. UNIQUE per
 * (lot_id, units_consumed_before): the POSITION lock — the insert-as-lock
 * arbiter (the PR 12 accumulator / PR 99 amortization discipline) — so two
 * concurrent consumers of one lot compute the same position and exactly one
 * wins it; the loser re-derives from the append-only truth.
 */
export type MerchCogsConsumptionRecord = {
  id: string;
  lot_id: string;
  /** The fulfillment event's content-derived event id — the replay guard. */
  source_event_id: string;
  /** The lot's consumed-units position the instant before this consumption. */
  units_consumed_before: number;
  units_consumed: number;
  /** The lot's per-unit cost at consumption — recorded, never recomputed. */
  cogs_per_unit_cents: number;
  /** units_consumed × cogs_per_unit_cents — the exact integer amortization. */
  amortized_cents: number;
  created_at: string;
};

/**
 * The brand-collaboration deal of record (migration 0026) — one per sku
 * (upsert on sku_id, the option-agreement precedent). Names the
 * manufacturing party (the waterfall's first-priority recovery holder),
 * the brand, and the collaborating artist with a basis-point split of the
 * post-recoupment remainder, plus the fronted overhead amounts — blank
 * sourcing and screen printing — recouped 100% before any profit split.
 */
export type MerchCollabAgreementRecord = {
  id: string;
  /** The merch sku the collaboration deal covers. */
  sku_id: string;
  manufacturer_payee_id: string;
  manufacturer_payee_name: string;
  brand_payee_id: string;
  brand_payee_name: string;
  artist_payee_id: string;
  artist_payee_name: string;
  /** The artist's split of the post-recoupment remainder, basis points (0..10000). */
  artist_split_bps: number;
  /** The fronted blank-sourcing overhead — the step-one pool of record. */
  blank_sourcing_cents: number;
  /** The fronted screen-printing overhead — the step-one pool of record. */
  screen_printing_cents: number;
  /** The signed collaboration agreement the terms were extracted from. */
  agreement_ref: string;
  created_at: string;
  updated_at: string;
};

/**
 * The collab overhead-recoupment pool class of record — the two fronted
 * manufacturing pools the waterfall's step one recoups 100% to the
 * manufacturing party, blank sourcing before screen printing.
 */
export const MERCH_COLLAB_POOL_CLASSES = [
  "blank_sourcing",
  "screen_printing",
] as const;
export type MerchCollabPoolClass = (typeof MERCH_COLLAB_POOL_CLASSES)[number];

/**
 * One overhead-recoupment application (migration 0026) — the append-only
 * recovery ledger over a collab agreement's two pools, the 0024 pool
 * discipline at agreement scope. UNIQUE per (agreement_id, pool_class,
 * source_event_id): a replayed settlement is the unique violation, never a
 * double recovery. UNIQUE per (agreement_id, pool_class,
 * recouped_before_cents): the POSITION lock — the insert-as-lock arbiter.
 * The applications' sum is the pool's running recovery, derived — never a
 * second mutable counter.
 */
export type MerchCollabRecoupmentApplicationRecord = {
  id: string;
  agreement_id: string;
  pool_class: MerchCollabPoolClass;
  /** The settlement release's content-derived event id — the replay guard. */
  source_event_id: string;
  /** The pool's recouped position the instant before this application. */
  recouped_before_cents: number;
  applied_cents: number;
  remaining_cents: number;
  created_at: string;
};

/**
 * The design-IP royalty tier of record (migration 0026) — one per sku
 * (upsert on sku_id). The guest designer's flat per-unit royalty — e.g.
 * 350 cents per garment — is the state of record at fulfillment
 * processing time; billings price fulfillment events from this row, never
 * retroactively.
 */
export type MerchDesignerRoyaltyTierRecord = {
  id: string;
  sku_id: string;
  designer_payee_id: string;
  designer_payee_name: string;
  royalty_per_unit_cents: number;
  created_at: string;
  updated_at: string;
};

/**
 * One designer royalty billing (migration 0026) — the per-unit royalty
 * billed DIRECTLY to an order fulfillment event. One append-only row per
 * (source_event_id, sku_id): a replayed fulfillment event is the unique
 * violation, never a double billing. The tier FK guards the billing's
 * precondition (text → text unique, type-matched): a billing cannot exist
 * for a sku with no registered tier.
 */
export type MerchDesignerRoyaltyBillingRecord = {
  id: string;
  /** The fulfillment event's content-derived event id — the replay guard. */
  source_event_id: string;
  sku_id: string;
  designer_payee_id: string;
  designer_payee_name: string;
  units_billed: number;
  royalty_per_unit_cents: number;
  /** units_billed × royalty_per_unit_cents — the exact integer billing. */
  billed_cents: number;
  created_at: string;
};

/**
 * The wholesale consignment payout row of record (migration 0026) — the
 * durable shrinkage reconciliation. One row per content-derived payout
 * event (UNIQUE on event_id: a re-shipped report replays as the unique
 * violation, never a double settlement). The report's own arithmetic must
 * reconcile exactly (gross − commission − shrinkage = net payout) before
 * the row exists — a report whose rows do not reconcile is rejected whole.
 */
export type MerchConsignmentSettlementRecord = {
  id: string;
  event_id: string;
  period: string;
  location: string;
  sku_id: string;
  units_sold: number;
  gross_cents: number;
  commission_cents: number;
  /** The shrinkage/loss allowance OFFSET against the net payout. */
  shrinkage_allowance_cents: number;
  net_payout_cents: number;
  currency: string;
  created_at: string;
};

/**
 * The returns-reserve policy of record (migration 0027, PR 23) — one per
 * sku (upsert on sku_id), the founder-directive bands the founder directive
 * fixes: a 10–15% holdback rate (1000–1500 bps) and a 30–60 day reserve
 * window. The policy is the terms of record the dispatch lane withholds
 * from and the release lane reads its window from — never the caller.
 * The beneficiary payee of record is the creator the reserve releases to
 * after the window (the money terms come from the registry, never the
 * caller — the collab-agreement precedent).
 */
export type MerchReturnReservePolicyRecord = {
  id: string;
  sku_id: string;
  /** Whole basis points inside the founder band — 1000 (10%) to 1500 (15%). */
  reserve_rate_bps: number;
  /** Whole days inside the founder band — 30 to 60. */
  reserve_window_days: number;
  beneficiary_payee_id: string;
  beneficiary_payee_name: string;
  created_at: string;
  updated_at: string;
};

/**
 * The returns-reserve drawdown class of record — the two movements that
 * spend a reserve: a customer return and a chargeback. The class is
 * checked at the schema (migration 0027's CHECK) and at the lane.
 */
export const MERCH_RESERVE_DRAWDOWN_CLASSES = [
  "customer_return",
  "chargeback",
] as const;
export type MerchReserveDrawdownClass =
  (typeof MERCH_RESERVE_DRAWDOWN_CLASSES)[number];

/**
 * One returns-reserve drawdown (migration 0027) — the append-only truth a
 * reserve spends against, the 0026 recoupment-application discipline at
 * reserve scope. UNIQUE per (reserve_ledger_id, source_event_id): a
 * re-shipped return/chargeback event is the unique violation, never a
 * double drawdown. UNIQUE per (reserve_ledger_id, drawn_before_cents): the
 * POSITION lock — the insert-as-lock arbiter — so two concurrent drawdowns
 * of one reserve compute the same position and exactly one wins it; the
 * loser re-derives from the append-only truth. The drawn sum IS the
 * reserve's spend — derived, never a second mutable counter.
 */
export type MerchReserveDrawdownRecord = {
  id: string;
  /** The held reserve credit's ledger row id — the reserve being spent. */
  reserve_ledger_id: string;
  drawdown_class: MerchReserveDrawdownClass;
  /** The return/chargeback event's content-derived id — the replay guard. */
  source_event_id: string;
  /** The reserve's drawn position the instant before this drawdown. */
  drawn_before_cents: number;
  drawn_cents: number;
  remaining_cents: number;
  created_at: string;
};

/**
 * The fulfillment tracking state of record — the carrier event lifecycle the
 * merch payout gate's physical_fulfillment_confirmed condition resolves
 * from. Only 'delivered' confirms; 'assigned' and 'in_transit' are honest
 * not-yet states the gate refuses on (fail-closed), and an absent tracking
 * ledger is an unknown that refuses the same way.
 */
export const MERCH_FULFILLMENT_TRACKING_STATES = [
  "assigned",
  "in_transit",
  "delivered",
] as const;
export type MerchFulfillmentTrackingState =
  (typeof MERCH_FULFILLMENT_TRACKING_STATES)[number];

/**
 * One fulfillment tracking event (migration 0027) — the fulfillment data
 * the merch payout gate reads. UNIQUE per (fulfillment_event_id,
 * tracking_number, tracking_state): a re-shipped tracking event is the
 * unique violation, never a double record. The confirmation the gate
 * enforces is a DELIVERED event on the fulfillment event — tracking
 * assigned or in transit does not confirm, and no tracking at all is
 * unknown (both refuse, fail-closed).
 */
export type MerchFulfillmentTrackingRecord = {
  id: string;
  fulfillment_event_id: string;
  tracking_number: string;
  tracking_state: MerchFulfillmentTrackingState;
  carrier: string;
  /** The delivery instant when tracking_state is 'delivered'; null before. */
  delivered_at: string | null;
  created_at: string;
};

/**
 * The withholding-tax-credit verification state of record (PR 27, the
 * foreign tax hold) — the evidence lifecycle a country+tax-year's foreign
 * print royalties release against. Only 'verified' releases the hold;
 * 'pending' and 'failed' are honest not-yet states, and an absent
 * verification is an unknown — all refuse, fail-closed.
 */
export const WITHHOLDING_TAX_CREDIT_STATES = [
  "pending",
  "verified",
  "failed",
] as const;
export type WithholdingTaxCreditState =
  (typeof WITHHOLDING_TAX_CREDIT_STATES)[number];

/**
 * One withholding tax credit verification (PR 27, migration 0031) — the
 * VERIFIED evidence that a foreign sale territory's withholding tax was
 * credited at treaty terms (for example US-UK treaty evidence) for one tax
 * year. UNIQUE per (country_code, tax_year): a re-recording converges (the
 * evidence upgrade pending → verified replaces the row atomically). A
 * 'verified' state REQUIRES the treaty reference, the evidence provenance,
 * and the verifier — the state never lies about the credit.
 */
export type WithholdingTaxCreditVerificationRecord = {
  id: string;
  /** The sale territory's ISO-3166 alpha-2 country code, normalized uppercase. */
  country_code: string;
  tax_year: number;
  state: WithholdingTaxCreditState;
  /** The treaty of record the credit claims (required for 'verified'). */
  treaty_ref: string | null;
  /** The credit evidence's provenance (required for 'verified'). */
  evidence_ref: string | null;
  /** Who verified the evidence (required for 'verified'). */
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The ISBN rights verification state of record (PR 27) — the print-title
 * rights chain the publishing payout gate's isbn_rights_verified condition
 * resolves from. Only 'verified' passes; absent, pending, and failed all
 * refuse, fail-closed.
 */
export const ISBN_RIGHTS_STATES = ["pending", "verified", "failed"] as const;
export type IsbnRightsState = (typeof ISBN_RIGHTS_STATES)[number];

/**
 * One ISBN rights verification (PR 27, migration 0031) — the print title's
 * verified rights chain of record. UNIQUE per isbn: a re-verification
 * replaces the row atomically. A 'verified' state requires the rights
 * evidence provenance — the state never lies about the chain.
 */
export type IsbnRightsVerificationRecord = {
  id: string;
  isbn: string;
  state: IsbnRightsState;
  /** The rights evidence's provenance (required for 'verified'). */
  evidence_ref: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The book returns-reserve drawdown class of record (PR 27) — the two
 * movements that spend a book reserve: a publisher's return of unsold
 * bookstore stock and a payment chargeback. The class is checked at the
 * schema (migration 0031's CHECK) and at the lane.
 */
export const BOOK_RESERVE_DRAWDOWN_CLASSES = [
  "publisher_return",
  "chargeback",
] as const;
export type BookReserveDrawdownClass =
  (typeof BOOK_RESERVE_DRAWDOWN_CLASSES)[number];

/**
 * The book returns-reserve policy of record per ISBN (PR 27, migration
 * 0031) — the founder-banded money terms the lock lane withholds from and
 * the release lanes read. Bands are CHECK-enforced at rest and
 * lane-enforced at write.
 */
export type BookReturnsReservePolicyRecord = {
  id: string;
  isbn: string;
  /** Whole basis points inside the founder band — 1500 (15%) to 2000 (20%). */
  reserve_rate_bps: number;
  /** Whole days inside the founder band — 90 to 120. */
  reserve_window_days: number;
  beneficiary_payee_id: string;
  beneficiary_payee_name: string;
  created_at: string;
  updated_at: string;
};

/**
 * One book returns-reserve drawdown (PR 27, migration 0031) — the
 * append-only truth a reserve spends against, the merch reserve discipline
 * (PR 23) at ISBN scope. UNIQUE per (reserve_ledger_id, source_event_id):
 * a re-shipped return/chargeback event is the unique violation, never a
 * double drawdown. UNIQUE per (reserve_ledger_id, drawn_before_cents): the
 * POSITION lock — the insert-as-lock arbiter. The drawn sum IS the
 * reserve's spend — derived, never a second mutable counter.
 */
export type BookReserveDrawdownRecord = {
  id: string;
  /** The held reserve credit's ledger row id — the reserve being spent. */
  reserve_ledger_id: string;
  drawdown_class: BookReserveDrawdownClass;
  /** The return/chargeback event's content-derived id — the replay guard. */
  source_event_id: string;
  /** The reserve's drawn position the instant before this drawdown. */
  drawn_before_cents: number;
  drawn_cents: number;
  remaining_cents: number;
  created_at: string;
};

/**
 * One publisher return chargeback of record (PR 27, migration 0031) — the
 * chargeback event against one ISBN's print allocations, the input the
 * reserve drawdowns and the POD-net offset applications reconcile against.
 * UNIQUE per event_id: a re-shipped chargeback event is the counted no-op,
 * never a double record. The chargeback's recovery splits across two
 * lanes: the title's held reserves (book_reserve_drawdowns rows with this
 * event's id as source_event_id) and the outstanding remainder's offset
 * against incoming POD net (book_chargeback_offset_applications rows).
 */
export type BookReturnChargebackRecord = {
  id: string;
  /** The chargeback event's content-derived id — the replay guard. */
  event_id: string;
  isbn: string;
  chargeback_class: BookReserveDrawdownClass;
  chargeback_cents: number;
  currency: string;
  created_at: string;
};

/**
 * One chargeback offset application against an incoming POD net balance
 * (PR 27, migration 0031) — the append-only truth of the publisher's
 * recovery taken OUT of a specific held print allocation BEFORE author
 * payouts release. UNIQUE per (chargeback_id, holding_ledger_id): a
 * replayed release is the unique violation, never a double offset. UNIQUE
 * per (chargeback_id, offset_before_cents): the POSITION lock — exactly one
 * release wins an offset's next running position per chargeback.
 */
export type BookChargebackOffsetApplicationRecord = {
  id: string;
  /** The chargeback of record this application recovers against. */
  chargeback_id: string;
  /** The held print allocation the offset consumed from. */
  holding_ledger_id: string;
  /** The chargeback's applied position the instant before this application. */
  offset_before_cents: number;
  applied_cents: number;
  remaining_cents: number;
  created_at: string;
};

/**
 * The AI lane's bounded contributor-class vocabulary (PR 24, the founder
 * AI directive + tokenization patch) — the training registry's classes of
 * record. Data providers, voice sources, and original-IP owners share the
 * directive's 30% contributor pool; the class is the audit trail's
 * attribution fact, never a money-math input (the pro-rata token weights
 * price the shares).
 */
export const AI_CONTRIBUTOR_CLASSES = [
  "dataset",
  "voice",
  "original_ip",
] as const;
export type AiContributorClass = (typeof AI_CONTRIBUTOR_CLASSES)[number];

/**
 * One model's nested derivative split contract terms of record (migration
 * 0028) — the directive's defaults (2000/5000/3000 bps) made per-contract
 * configurable. UNIQUE per ai_model_id: one contract prices one model; a
 * re-registered terms row is an upsert (the newest contract governs), and
 * the recon posting pass reads it at each ingest.
 */
export type AiModelSplitTermsRecord = {
  id: string;
  /** UNIQUE — the model the terms price (the addendum 9 ai_model_id key). */
  ai_model_id: string;
  /** The base foundation model provider's system fee, whole bps off the top. */
  base_model_provider_fee_bps: number;
  /** The fine-tuner / LoRA creator's split of the post-fee remainder, bps. */
  developer_split_bps: number;
  /** The data + voice + original-IP contributor pool of the remainder, bps. */
  contributor_pool_bps: number;
  base_model_provider_payee_id: string;
  base_model_provider_payee_name: string;
  developer_payee_id: string;
  developer_payee_name: string;
  model_operator_payee_id: string;
  model_operator_payee_name: string;
  created_at: string;
  updated_at: string;
};

/**
 * One contributor's registered dataset token weight on one model
 * (migration 0028) — the model registry the posting pass resolves an
 * unattributed inference event's contributor pool through, and the
 * pro-rata denominator's inputs for training-pool royalties. UNIQUE per
 * (ai_model_id, contributor_payee_id): a re-shipped attribution log is an
 * upsert (the newest weight governs the next distribution), never a
 * double registration.
 */
export type AiModelContributionRecord = {
  id: string;
  ai_model_id: string;
  contributor_payee_id: string;
  contributor_payee_name: string;
  /** The bounded class vocabulary above — the attribution fact of record. */
  contributor_class: AiContributorClass;
  /** The contributor's exact decimal dataset token weight (1e-8 micros text). */
  dataset_token_weight: string;
  created_at: string;
  updated_at: string;
};


// ---------------------------------------------------------------------------
// AI training dispute freeze + payout gate states + dataset deprecations
// (migration 0029, PR 25 — the founder AI directive + the tokenization
// patch's opt-out mechanics).
// ---------------------------------------------------------------------------

/** The bounded lifecycle of an IP attribution dispute against a training dataset. */
export const AI_TRAINING_DISPUTE_STATUSES = [
  "filed",
  "resolved",
] as const;
export type AiTrainingDisputeStatus =
  (typeof AI_TRAINING_DISPUTE_STATUSES)[number];

/**
 * One rights holder's IP attribution dispute against a model's training
 * dataset version (migration 0029). An ACTIVE dispute (status 'filed')
 * freezes the model's unclaimed-holding legs into
 * status 'unauthorized_training_hold' — the ledger shows the money, the
 * release path refuses it. UNIQUE per (ai_model_id, dataset_version,
 * rights_holder_payee_id): a re-filed dispute converges on the existing
 * row (the freeze sweep re-runs as a counted no-op), never a duplicate.
 */
export type AiTrainingDisputeRecord = {
  id: string;
  /** The model whose inference payouts the dispute freezes. */
  ai_model_id: string;
  /** The disputed training dataset version of record (the attribution-log identity). */
  dataset_version: string;
  rights_holder_payee_id: string;
  rights_holder_payee_name: string;
  /** The dispute's stated basis (the filing's attribution claim). */
  dispute_basis: string;
  status: AiTrainingDisputeStatus;
  /** The verified resolution's record — set only through the resolution CAS. */
  resolution_notes: string | null;
  resolved_at: string | null;
  /** The operator identity that carried the verified resolution. */
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The AI training-consent state of record — the bounded tri-state
 * vocabulary. 'unknown' is a DISTINCT stored state (an investigation that
 * has not concluded), not a synonym for 'unverified': both refuse the
 * payout gate, but the audit trail can tell "no" from "not yet known".
 * An ABSENT row (no record for the payee) also refuses — fail-closed when
 * absent or unknown, the locked discipline.
 */
export const AI_CONSENT_STATES = [
  "verified",
  "unverified",
  "unknown",
] as const;
export type AiConsentState = (typeof AI_CONSENT_STATES)[number];

/** The synthetic voice/likeness release state — the same tri-state discipline. */
export const AI_LIKENESS_STATES = [
  "released",
  "withheld",
  "unknown",
] as const;
export type AiLikenessState = (typeof AI_LIKENESS_STATES)[number];

/**
 * One payee's AI payout-gate states of record (migration 0029) — the
 * persisted facts the AI vertical's compliance state resolves through.
 * UNIQUE per payee_id: an upsert converges (the newest state governs the
 * next dispatch). The AI payout gate reads these fail-closed: the release
 * proceeds only when ai_training_consent_verified is 'verified' AND
 * synthetic_voice_likeness_released is 'released' — anything else
 * (absent, unknown, unverified, withheld) refuses.
 */
export type AiPayoutGateStateRecord = {
  id: string;
  /** UNIQUE — the payee whose AI payouts these states gate. */
  payee_id: string;
  /** The model the states were recorded against, when model-scoped. */
  ai_model_id: string | null;
  ai_training_consent_state: AiConsentState;
  synthetic_voice_likeness_state: AiLikenessState;
  /** The operator identity that recorded the state. */
  verified_by: string | null;
  created_at: string;
  updated_at: string;
};

/** The bounded vocabulary of dataset-version deprecation reasons. */
export const AI_DEPRECATION_REASONS = [
  "rights_withdrawal",
  "model_deprecation",
  "tokenization_opt_out",
] as const;
export type AiDeprecationReason =
  (typeof AI_DEPRECATION_REASONS)[number];

/**
 * One dataset version's deprecation of record (migration 0029) — the
 * rights withdrawal / opt-out / model-deprecation fact. UNIQUE per
 * (ai_model_id, dataset_version): a re-deprecation converges. When
 * rights_holder_payee_id is set the deprecation is THAT contributor's
 * opt-out (their allocations halt individually); when null the whole
 * dataset version halts. Deprecation HALTS future payout allocations to
 * the version and ARCHIVES the historical allocation records — the
 * append-only ledger trail is never deleted.
 */
export type AiDatasetDeprecationRecord = {
  id: string;
  /** UNIQUE with dataset_version — the model whose registry the version sits in. */
  ai_model_id: string;
  /** UNIQUE with ai_model_id — the deprecated dataset version (the pool event id of record). */
  dataset_version: string;
  reason: AiDeprecationReason;
  /** The withdrawing rights holder when the deprecation is a named opt-out. */
  rights_holder_payee_id: string | null;
  rights_holder_payee_name: string | null;
  deprecated_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * One archived historical allocation of a deprecated dataset version
 * (migration 0029). The ARCHIVE is the clean retirement record: the
 * referenced ledger row is NEVER deleted or rewritten (the append-only
 * trail stays intact) — this row is the queryable fact that the
 * allocation belonged to a since-deprecated version. UNIQUE per
 * (deprecation_id, ledger_transaction_id): a re-run deprecation
 * converges, never double-archives.
 */
export type AiDatasetAllocationArchiveRecord = {
  id: string;
  /** The deprecation that archived this allocation. */
  deprecation_id: string;
  /** The archived ledger row — untouched, still on the append-only trail. */
  ledger_transaction_id: string;
  /** The contributor the allocation credited (the platform variance payee for dust legs). */
  contributor_payee_id: string;
  amount_cents: number;
  currency: string;
  archived_at: string;
};

