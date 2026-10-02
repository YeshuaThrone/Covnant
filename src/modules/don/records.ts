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
