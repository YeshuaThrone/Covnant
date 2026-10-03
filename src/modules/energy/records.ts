
/**
 * The energy resource record vocabulary (PR 48, migration 0052) — the
 * founder resource directive's durable facts of record for energy,
 * mineral, and compute infrastructure reconciliation:
 *
 *   energy_land_parcels                     — one surveyed land parcel of
 *                                             record (the acreage
 *                                             division's registry).
 *   energy_parcel_owner_interests           — one deeded fractional
 *                                             owner's acreage interest
 *                                             (the division's legs'
 *                                             basis).
 *   energy_parcel_royalty_policies          — one parcel's tiered
 *                                             royalty policy of record
 *                                             (the mineral ORRI ladder).
 *   energy_parcel_royalty_positions         — one parcel's cumulative
 *                                             royalty-basis position per
 *                                             period (the tier walk's
 *                                             input and the cumulative
 *                                             tracking of record).
 *   energy_compute_yield_policies           — one GPU cluster's yield
 *                                             split policy of record
 *                                             (the sponsors' share
 *                                             ladder).
 *   energy_compute_yield_positions          — one cluster's cumulative
 *                                             yield position per period.
 *   energy_grid_participant_registrations   — one cluster participant's
 *                                             registration of record
 *                                             (class + telemetry
 *                                             weight).
 *   energy_division_orders                  — one parsed title division
 *                                             order of record.
 *   energy_deed_transfers                   — one deed transfer of
 *                                             record (the title move
 *                                             AND the statutory
 *                                             interest rate of record
 *                                             at transfer).
 *   energy_carbon_offset_policies           — one parcel's per-tonne
 *                                             offset payout policy of
 *                                             record (trust +
 *                                             developer).
 *   energy_meter_sales_posts                — the append-only SCADA
 *                                             meter row post (the
 *                                             realization's gross side
 *                                             replay guard).
 *   energy_pipeline_deduction_posts         — the append-only pipeline
 *                                             row post (the
 *                                             realization's deduction
 *                                             side replay guard).
 *   energy_gpu_utilization_posts            — the append-only GPU row
 *                                             post (the compute walks'
 *                                             replay guard).
 *   energy_net_realization_applications     — the Net Realized Resource
 *                                             Pool of record per
 *                                             (parcel, meter, cluster,
 *                                             period, currency) —
 *                                             recomputed in place from
 *                                             the posts (the
 *                                             cross-license settlement
 *                                             precedent).
 *   energy_parcel_division_applications     — the append-only monthly
 *                                             acreage division per
 *                                             royalty event.
 *   energy_compute_grid_split_applications  — the append-only dynamic
 *                                             grid split per GPU row
 *                                             (the instant cascade's
 *                                             record).
 *   energy_statutory_interest_applications  — the append-only statutory
 *                                             interest accrual per
 *                                             rerouted division leg.
 *   energy_carbon_offset_payout_applications — the append-only per-tonne
 *                                             payout per registry mint.
 *
 * Shape discipline (the hardware module precedent): every application is
 * append-only and keyed on a content-derived source event id — the
 * replay guard; every registry upsert converges on its natural key;
 * money is exact integer cents (statement micros only inside the
 * parsers); the vocabularies are byte-identical to the 0052 SQL CHECKs.
 */

// ---------------------------------------------------------------------------
// Vocabulary — the bounded sets, byte-identical to the SQL CHECKs where a
// column carries both (the PR 129/130/133/134 lesson: drift between the
// engine's union and the schema's CHECK is a production rejection waiting
// to fire).
// ---------------------------------------------------------------------------

/** The energy lane's application verdict of record. `posted` — the
 * realization, division, split, accrual, or payout priced and committed;
 * `held_negative_net` — the realization's deduction legs exceeded the
 * gross sales (the money pauses, visible, never dropped, never guessed
 * into a route). Byte-identical to
 * ck_energy_net_realization_applications_verdict_vocabulary. */
export const ENERGY_APPLICATION_VERDICTS = [
  "posted",
  "held_negative_net",
] as const;
export type EnergyApplicationVerdict = (typeof ENERGY_APPLICATION_VERDICTS)[number];

/** The deeded interest class of record — the title's character of the
 * owner's acreage. Byte-identical to
 * ck_energy_parcel_owner_interests_interest_class_vocabulary. */
export const ENERGY_INTEREST_CLASSES = [
  "mineral",
  "surface",
  "wind",
  "mixed",
] as const;
export type EnergyInterestClass = (typeof ENERGY_INTEREST_CLASSES)[number];

/** The grid participant class of record — the three infrastructure
 * counterparties the founder's compute-grid split names.
 * Byte-identical to
 * ck_energy_grid_participant_registrations_participant_class_vocabulary. */
export const ENERGY_GRID_PARTICIPANT_CLASSES = [
  "gpu_hardware_owner",
  "power_plant_operator",
  "colocation_manager",
] as const;
export type EnergyGridParticipantClass =
  (typeof ENERGY_GRID_PARTICIPANT_CLASSES)[number];

/** The parcel royalty tier band — the revenue-window ladder (mirrors the
 * engine's EnergyRoyaltyTierBand; stored as JSON text). */
export type EnergyRoyaltyTierBandRecord = {
  up_to: number | null;
  royalty_bps: number;
};

// ---------------------------------------------------------------------------
// Registries — the upsert-converging facts of record.
// ---------------------------------------------------------------------------

/** One surveyed land parcel of record (`energy_land_parcels`). UNIQUE
 * per parcel_id. */
export interface EnergyLandParcelRecord {
  id: string;
  /** The founder-specified parcel identity — the realization keys on
   * it. UNIQUE. */
  parcel_id: string;
  parcel_name: string;
  region: string;
  created_at: string;
  updated_at: string;
}

/** One deeded fractional owner's acreage interest
 * (`energy_parcel_owner_interests`). UNIQUE per (parcel_id,
 * owner_payee_id). */
export interface EnergyParcelOwnerInterestRecord {
  id: string;
  parcel_id: string;
  owner_payee_id: string;
  owner_name: string;
  /** The deeded surveyed acreage in micros (1 acre = 1e6 micros) — the
   * division's ratio basis. */
  deeded_acres_micros: number;
  interest_class: EnergyInterestClass;
  created_at: string;
  updated_at: string;
}

/** One parcel's tiered royalty policy of record
 * (`energy_parcel_royalty_policies`). UNIQUE per parcel_id. */
export interface EnergyParcelRoyaltyPolicyRecord {
  id: string;
  parcel_id: string;
  /** The tier bands' JSON text — the ladder the walk prices from
   * (validateEnergyRoyaltyBands ran before persist). */
  tier_bands: string;
  created_at: string;
  updated_at: string;
}

/** One parcel's cumulative royalty position per period
 * (`energy_parcel_royalty_positions`). UNIQUE per (parcel_id, period,
 * currency). */
export interface EnergyParcelRoyaltyPositionRecord {
  id: string;
  parcel_id: string;
  period: string;
  currency: string;
  cumulative_revenue_cents: number;
  cumulative_royalty_cents: number;
  created_at: string;
  updated_at: string;
}

/** One GPU cluster's yield split policy of record
 * (`energy_compute_yield_policies`). UNIQUE per gpu_cluster_hash. */
export interface EnergyComputeYieldPolicyRecord {
  id: string;
  /** The founder-specified GPU cluster hash — the compute keys ride
   * it. UNIQUE. */
  gpu_cluster_hash: string;
  sponsor_payee_id: string;
  sponsor_payee_name: string;
  tier_bands: string;
  created_at: string;
  updated_at: string;
}

/** One cluster's cumulative yield position per period
 * (`energy_compute_yield_positions`). UNIQUE per (gpu_cluster_hash,
 * period, currency). */
export interface EnergyComputeYieldPositionRecord {
  id: string;
  gpu_cluster_hash: string;
  period: string;
  currency: string;
  cumulative_compute_revenue_cents: number;
  cumulative_yield_cents: number;
  created_at: string;
  updated_at: string;
}

/** One cluster participant's registration of record
 * (`energy_grid_participant_registrations`). UNIQUE per
 * (gpu_cluster_hash, participant_payee_id). */
export interface EnergyGridParticipantRegistrationRecord {
  id: string;
  gpu_cluster_hash: string;
  participant_payee_id: string;
  participant_payee_name: string;
  participant_class: EnergyGridParticipantClass;
  /** The participant's registered telemetry weight in micros — the
   * row's telemetry scales it (the split's dynamic basis). */
  weight_micros: number;
  created_at: string;
  updated_at: string;
}

/** One parsed title division order of record
 * (`energy_division_orders`). UNIQUE per order_ref. */
export interface EnergyDivisionOrderRecord {
  id: string;
  order_ref: string;
  parcel_id: string;
  owner_payee_id: string;
  owner_payee_name: string;
  /** The order's stated fractional interest, in bps of the parcel. */
  interest_bps: number;
  /** The order's effective date of record (ISO date, YYYY-MM-DD). */
  effective_on: string;
  created_at: string;
  updated_at: string;
}

/** One deed transfer of record (`energy_deed_transfers`). UNIQUE per
 * deed_ref. */
export interface EnergyDeedTransferRecord {
  id: string;
  deed_ref: string;
  parcel_id: string;
  from_payee_id: string;
  to_payee_id: string;
  /** The acreage the deed moved, in micros. */
  transferred_acres_micros: number;
  /** The statutory interest rate of record AT the transfer — the rate
   * the rerouted legs accrue at. */
  statutory_interest_bps: number;
  /** The recording date of record (ISO date, YYYY-MM-DD). */
  recorded_on: string;
  created_at: string;
  updated_at: string;
}

/** One parcel's per-tonne offset payout policy of record
 * (`energy_carbon_offset_policies`). UNIQUE per parcel_id. */
export interface EnergyCarbonOffsetPolicyRecord {
  id: string;
  parcel_id: string;
  trust_payee_id: string;
  trust_payee_name: string;
  developer_payee_id: string;
  developer_payee_name: string;
  /** The policy's rate of record: money statement micros per tonne
   * ($1.50/tonne = 150_000_000). */
  micros_per_tonne: number;
  trust_share_bps: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Posts — the append-only per-row replay guards.
// ---------------------------------------------------------------------------

/** One SCADA meter row's post of record (`energy_meter_sales_posts`) —
 * the gross-sales side of the realization. UNIQUE per source_event_id. */
export interface EnergyMeterSalesPostRecord {
  id: string;
  source_event_id: string;
  parcel_id: string;
  well_meter_id: string;
  /** The GPU cluster hash of record ('' where the parcel carries no
   * compute — the NULL-distinctness avoidance). */
  gpu_cluster_hash: string;
  period: string;
  currency: string;
  gross_energy_sales_cents: number;
  gross_mineral_sales_cents: number;
  created_at: string;
}

/** One pipeline row's post of record
 * (`energy_pipeline_deduction_posts`) — the deduction side of the
 * realization. UNIQUE per source_event_id. */
export interface EnergyPipelineDeductionPostRecord {
  id: string;
  source_event_id: string;
  parcel_id: string;
  well_meter_id: string;
  gpu_cluster_hash: string;
  period: string;
  currency: string;
  transportation_pipeline_deductions_cents: number;
  grid_transmission_fees_cents: number;
  processing_refining_base_fees_cents: number;
  created_at: string;
}

/** One GPU row's post of record (`energy_gpu_utilization_posts`) — the
 * compute walks' replay guard. UNIQUE per source_event_id. */
export interface EnergyGpuUtilizationPostRecord {
  id: string;
  source_event_id: string;
  gpu_cluster_hash: string;
  period: string;
  currency: string;
  /** The row's compute hours in micros. */
  compute_hours_micros: number;
  /** The row's average power draw in kilowatt micros. */
  power_draw_kw_micros: number;
  compute_revenue_cents: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Applications — the append-only money records (the realization
// upserts-in-place: it is a position of record recomputed from the
// posts, the cross-license settlement precedent).
// ---------------------------------------------------------------------------

/** The Net Realized Resource Pool of record per
 * (parcel_id, well_meter_id, gpu_cluster_hash, period, currency)
 * (`energy_net_realization_applications`). Recomputed in place from the
 * meter + pipeline post sums on every post — the id and created_at
 * survive (the PR 33 id-rotation lesson). */
export interface EnergyNetRealizationApplicationRecord {
  id: string;
  /** The content-derived event id over the five-tuple — the walk's
   * replay-check handle. UNIQUE. */
  source_event_id: string;
  parcel_id: string;
  well_meter_id: string;
  gpu_cluster_hash: string;
  period: string;
  currency: string;
  gross_energy_sales_cents: number;
  gross_mineral_sales_cents: number;
  transportation_pipeline_deductions_cents: number;
  grid_transmission_fees_cents: number;
  processing_refining_base_fees_cents: number;
  /** THE NET REALIZED RESOURCE POOL — may be negative (the held
   * verdict). */
  net_realized_resource_pool_cents: number;
  verdict: EnergyApplicationVerdict;
  created_at: string;
  updated_at: string;
}

/** One division leg of record (JSON text inside the division
 * application). */
export type EnergyDivisionLegRecord = {
  payee_id: string;
  deeded_acres_micros: number;
  allocated_cents: number;
};

/** The append-only monthly acreage division of record
 * (`energy_parcel_division_applications`). UNIQUE per source_event_id. */
export interface EnergyParcelDivisionApplicationRecord {
  id: string;
  source_event_id: string;
  parcel_id: string;
  period: string;
  currency: string;
  /** The royalty pot the tier walk priced — the division's basis. */
  revenue_basis_cents: number;
  /** The division legs' JSON text (per heir: payee, acres, cents). */
  division_legs: string;
  allocated_total_cents: number;
  owner_count: number;
  created_at: string;
}

/** One grid-split leg of record (JSON text inside the split
 * application). */
export type EnergyGridSplitLegRecord = {
  payee_id: string;
  participant_class: EnergyGridParticipantClass;
  effective_weight_micros: number;
  allocated_cents: number;
};

/** The append-only dynamic grid split of record
 * (`energy_compute_grid_split_applications`) — the instant cascade's
 * record. UNIQUE per source_event_id. */
export interface EnergyComputeGridSplitApplicationRecord {
  id: string;
  source_event_id: string;
  gpu_cluster_hash: string;
  period: string;
  currency: string;
  compute_revenue_cents: number;
  /** The split legs' JSON text (per participant: payee, class, weight,
   * cents). */
  split_legs: string;
  allocated_total_cents: number;
  /** The instant posting's journal of record (null when the split
   * recorded but the posting did not run — the reconciliation gap). */
  journal_id: string | null;
  created_at: string;
}

/** The append-only statutory interest accrual of record
 * (`energy_statutory_interest_applications`). UNIQUE per
 * source_event_id. */
export interface EnergyStatutoryInterestApplicationRecord {
  id: string;
  source_event_id: string;
  parcel_id: string;
  deed_ref: string;
  period: string;
  currency: string;
  base_cents: number;
  late_days: number;
  statutory_interest_bps: number;
  interest_cents: number;
  created_at: string;
}

/** The append-only per-tonne carbon offset payout of record
 * (`energy_carbon_offset_payout_applications`). UNIQUE per
 * source_event_id. */
export interface EnergyCarbonOffsetPayoutApplicationRecord {
  id: string;
  source_event_id: string;
  parcel_id: string;
  registry_ref: string;
  period: string;
  currency: string;
  tonnes_verified_micros: number;
  /** The rate of record at payout: money statement micros per tonne. */
  micros_per_tonne: number;
  trust_share_bps: number;
  trust_payee_id: string;
  trust_payout_cents: number;
  developer_payee_id: string;
  developer_payout_cents: number;
  total_payout_cents: number;
  created_at: string;
}


// ---------------------------------------------------------------------------
// PR 49 — the resource audit escrow, the resource payout gate states, and the
// scope identity. The RESOURCE_AUDIT_ESCROW is the energy/resource twin of the
// audit escrows at the founder's standard band (500–1500 bps — 5–15% of a
// resource payout), keyed per (owner payee, parcel): mineral-rights and
// surface owners ride division-order payouts whose commodity price can be
// re-trued by monthly reconciliations, whose gathering pipelines can run
// volumetric variance audits, and whose parcels carry environmental regulatory
// exposure. Drawdowns and the release follow the escrow family's position
// locks; the resource payout gate reads the two durable gate states below,
// fail-closed (absent and unknown BOTH refuse).
// ---------------------------------------------------------------------------

/** The RESOURCE_AUDIT_ESCROW's three drawdown classes of record — exactly
 * the resource exposures the founder directive names: monthly commodity
 * price reconciliations, pipeline variance audits, and environmental
 * regulatory compliance checks. Anything else refuses. This array is the
 * TS side of the vocabulary the SQL CHECKs enforce byte-identically
 * (migration 0053; the PR 129/130 lesson — verified byte-identical
 * before CI). */
export const RESOURCE_AUDIT_ESCROW_DRAWDOWN_CLASSES = [
  "commodity_price_reconciliation",
  "pipeline_variance_audit",
  "environmental_compliance_check",
] as const;
export type ResourceAuditEscrowDrawdownClass =
  (typeof RESOURCE_AUDIT_ESCROW_DRAWDOWN_CLASSES)[number];

/** The resource payout gate's environmental regulatory compliance states of
 * record (migration 0053) — byte-identical to the SQL CHECK vocabulary
 * ck_energy_resource_payout_gate_states_environmental_state_vocabulary. */
export const RESOURCE_GATE_ENVIRONMENTAL_STATES = ["unknown", "cleared"] as const;
export type ResourceGateEnvironmentalState =
  (typeof RESOURCE_GATE_ENVIRONMENTAL_STATES)[number];

/** The resource payout gate's title ownership verification states of record
 * (migration 0053) — byte-identical to the SQL CHECK vocabulary
 * ck_energy_resource_payout_gate_states_title_state_vocabulary. */
export const RESOURCE_GATE_TITLE_STATES = ["unknown", "verified"] as const;
export type ResourceGateTitleState = (typeof RESOURCE_GATE_TITLE_STATES)[number];

/** The resource payout gate's states of record for one owner payee on one
 * parcel (migration 0053) — the two states the payout gate's resource case
 * reads, fail-closed: `environmental_compliance_cleared` is true only when
 * the state is 'cleared', `title_ownership_verification_passed` is true
 * only when the state is 'verified'; an absent record resolves null and
 * 'unknown' resolves false. */
export interface ResourcePayoutGateStateRecord {
  readonly id: string;
  /** The payout's beneficiary of record (the parcel owner). */
  readonly payee_id: string;
  /** The parcel whose title and environmental posture govern the payout. */
  readonly parcel_id: string;
  /** The parcel's environmental regulatory compliance over the payout. */
  readonly environmental_compliance_state: ResourceGateEnvironmentalState;
  /** The owner's title ownership verification over the parcel. */
  readonly title_ownership_state: ResourceGateTitleState;
  /** The verification evidence of record. */
  readonly evidence_ref: string;
  /** Who verified the states of record. */
  readonly verified_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One scope's resource audit escrow rate of record (migration 0053) — a
 * founder-banded 500–1500 bps share of the scope's resource payouts that
 * locks into the RESOURCE_AUDIT_ESCROW bucket at routing. */
export interface ResourceAuditEscrowPolicyRecord {
  readonly id: string;
  /** `owner:{ownerPayeeId}:parcel:{parcelId}` — the scope key the escrow's
   * sentinel payee and GL account cite (the energy lane's own identifier
   * space, the same payee/parcel identity the 0052 tables key on). */
  readonly scope_key: string;
  /** The founder band: 500–1500 bps, checked at registration and again
   * at use (a hostile policy out-of-band refuses). */
  readonly reserve_rate_bps: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One position-locked escrow drawdown (migration 0053) — append-only.
 * UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
 * UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position lock
 * the balance is derived from. */
export interface ResourceAuditEscrowDrawdownRecord {
  readonly id: string;
  /** The escrow bucket's ledger_transactions row of record. */
  readonly reserve_ledger_id: string;
  readonly scope_key: string;
  readonly drawdown_class: ResourceAuditEscrowDrawdownClass;
  /** The drawing event's identity of record — the replay guard. */
  readonly source_event_id: string;
  /** The bucket balance this draw was taken against (the spend position). */
  readonly drawn_before_cents: number;
  /** The drawn amount: 0 < drawn_cents <= drawn_before_cents. */
  readonly drawn_cents: number;
  /** drawn_before_cents - drawn_cents, pinned in a CHECK. */
  readonly remaining_cents: number;
  readonly created_at: string;
}

/** The verified reconciliation of record for one escrow bucket (migration
 * 0053) — insert-as-lock, one per bucket: the release refuses fail-closed
 * until this row exists. */
export interface ResourceAuditEscrowReconciliationRecord {
  readonly id: string;
  readonly reserve_ledger_id: string;
  /** The reconciliation evidence of record (the monthly commodity price
   * reconciliation, the pipeline variance audit, the environmental
   * regulatory check). */
  readonly evidence_ref: string;
  /** Who verified the reconciliation of record. */
  readonly reconciled_by: string;
  readonly created_at: string;
}

/** The resource audit escrow's scope key — injective in the (owner payee,
 * parcel) pair, the same identifier space the 0052 energy tables key on.
 * The sentinel payee id, GL account, and policy row all cite it. */
export function resourceAuditEscrowScopeKey(
  ownerPayeeId: string,
  parcelId: string,
): string {
  return `owner:${ownerPayeeId}:parcel:${parcelId}`;
}
