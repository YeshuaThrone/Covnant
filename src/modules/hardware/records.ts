/**
 * The hardware patent record vocabulary (PR 46, migration 0050) — the
 * founder hardware directive's durable facts of record for semiconductor,
 * telecom, and connected-device patent reconciliation:
 *
 *   hardware_patent_pools                  — one patent pool of record
 *                                            (MPEG-LA / Avanci shaped:
 *                                            a named multi-owner pool
 *                                            keyed on its SEP pool code).
 *   hardware_pool_holder_legs              — one pool holder's verified
 *                                            essentiality score weighting
 *                                            (the waterfall's legs).
 *   hardware_sep_royalty_policies          — one patent family's FRAND
 *                                            royalty policy of record: the
 *                                            tiered per-unit rates with
 *                                            per-unit caps.
 *   hardware_automotive_pool_assignments   — one OEM production line's
 *                                            routing of record: the pools
 *                                            its per-vehicle cellular and
 *                                            navigation fees flow to.
 *   hardware_cleantech_royalty_policies    — one clean-tech patent
 *                                            family's telemetry micro-
 *                                            royalty policy of record.
 *   hardware_ota_unlock_policies           — one OTA feature's per-unlock
 *                                            royalty split policy of
 *                                            record (the sensor patent
 *                                            licensor's terms).
 *   hardware_cross_license_agreements      — one cross-licensing pair's
 *                                            agreement of record.
 *   hardware_sep_unit_months               — the cumulative monthly
 *                                            connected-unit tracker the
 *                                            tier walk prices from.
 *   hardware_realization_applications      — the append-only Net
 *                                            Hardware Patent Realization
 *                                            per device activation.
 *   hardware_sep_royalty_applications      — the append-only tiered SEP
 *                                            micro-royalty per MAC log
 *                                            event.
 *   hardware_pool_routing_applications     — the append-only automotive
 *                                            pool routing per production
 *                                            batch.
 *   hardware_pool_waterfall_applications   — the append-only essentiality
 *                                            waterfall per routing.
 *   hardware_telemetry_royalty_applications — the append-only clean-tech
 *                                            micro-payout per telemetry
 *                                            event.
 *   hardware_ota_unlock_applications       — the append-only OTA unlock
 *                                            split per unlock event (the
 *                                            instant-settlement record).
 *   hardware_cross_license_net_settlements — the append-only net balance
 *                                            clearing per agreement and
 *                                            period.
 *
 * Shape discipline (the developer module precedent): every application is
 * append-only and keyed on a content-derived source event id — the replay
 * guard; every registry upsert converges on its natural key; money is
 * exact integer cents (statement micros only inside the parsers); the
 * vocabularies are byte-identical to the 0050 SQL CHECKs.
 */

// ---------------------------------------------------------------------------
// Vocabulary — the bounded sets, byte-identical to the SQL CHECKs where a
// column carries both (the PR 129/130/133/134 lesson: drift between the
// engine's union and the schema's CHECK is a production rejection waiting
// to fire).
// ---------------------------------------------------------------------------

/** The device activation feed's two event kinds of record — the founder's
 * device activations and the OTA feature-unlock purchases that activate
 * hardware functionality over the air. The cellular activation profile's
 * bounded set (profile validation refuses any other token); no SQL column
 * carries it — the walk dispatches on the kind. */
export const HARDWARE_ACTIVATION_KINDS = [
  "device_activation",
  "ota_feature_unlock",
] as const;
export type HardwareActivationKind = (typeof HARDWARE_ACTIVATION_KINDS)[number];

/** The hardware lane's application verdict of record. `paid` — the
 * realization, royalty, routing, waterfall, payout, or split priced and
 * committed; `held_negative_net` — the realization's deduction legs
 * (component COGS base, non-essential BOM) exceeded the device wholesale
 * ASP, the money pauses visible (never dropped, never guessed into a
 * route). Byte-identical to the realization applications' SQL CHECK. */
export const HARDWARE_APPLICATION_VERDICTS = [
  "paid",
  "held_negative_net",
] as const;
export type HardwareApplicationVerdict =
  (typeof HARDWARE_APPLICATION_VERDICTS)[number];

/** The cross-license net settlement's directions of record — which side
 * of the agreement the net balance dispatches to, or `balanced` when the
 * mutual liabilities cancel exactly. Byte-identical to the net
 * settlements' SQL CHECK. */
export const HARDWARE_NET_DIRECTIONS = ["a_to_b", "b_to_a", "balanced"] as const;
export type HardwareNetDirection = (typeof HARDWARE_NET_DIRECTIONS)[number];

/** A FRAND tier band of record — the per-unit terms while the (licensee,
 * patent family, pool) cumulative unit position sits inside the band.
 * `up_to: null` is the open top band (it must sort last). Mirrors the
 * developer tier bands' shape. */
export type HardwareSepTierBand = {
  /** The band's exclusive upper unit bound; null = open top. */
  readonly up_to: number | null;
  /** The band's FRAND rate in basis points of the royalty basis. */
  readonly frand_rate_bps: number;
  /** The band's per-unit cap in exact cents (the $3 vehicle-module
   * ceiling of the founder example). */
  readonly per_unit_cap_cents: number;
};

// ---------------------------------------------------------------------------
// Registries — the policies and routings of record.
// ---------------------------------------------------------------------------

/** One patent pool of record (`hardware_patent_pools`). */
export interface HardwarePatentPoolRecord {
  id: string;
  /** The pool's SEP pool code — the founder-specified identity the
   * realization and royalty rows key on. UNIQUE. */
  pool_code: string;
  pool_name: string;
  created_at: string;
  updated_at: string;
}

/** One pool holder's verified essentiality weighting
 * (`hardware_pool_holder_legs`). UNIQUE per (pool_code, holder_payee_id). */
export interface HardwarePoolHolderLegRecord {
  id: string;
  pool_code: string;
  holder_payee_id: string;
  /** The verified essentiality score (1–100) — the waterfall's weight. */
  essentiality_score: number;
  created_at: string;
  updated_at: string;
}

/** One patent family's tiered FRAND royalty policy of record
 * (`hardware_sep_royalty_policies`). UNIQUE per
 * (patent_family_id, sep_pool_code). */
export interface HardwareSepRoyaltyPolicyRecord {
  id: string;
  patent_family_id: string;
  sep_pool_code: string;
  /** The policy's payee — the patent holder (or pool administrator) the
   * bilateral royalty routes to. */
  payee_id: string;
  /** The tier bands of record (JSON text, ascending, open top last). */
  tier_bands: string;
  created_at: string;
  updated_at: string;
}

/** One OEM production line's pool routing of record
 * (`hardware_automotive_pool_assignments`). UNIQUE per
 * (oem_id, line_id). */
export interface HardwareAutomotivePoolAssignmentRecord {
  id: string;
  oem_id: string;
  line_id: string;
  /** The pool the line's per-vehicle cellular licensing fees route to. */
  cellular_pool_code: string;
  /** The pool the line's per-vehicle navigation licensing fees route to. */
  navigation_pool_code: string;
  created_at: string;
  updated_at: string;
}

/** One clean-tech patent family's telemetry micro-royalty policy of
 * record (`hardware_cleantech_royalty_policies`). UNIQUE per
 * patent_family_id. */
export interface HardwareCleanTechRoyaltyPolicyRecord {
  id: string;
  patent_family_id: string;
  /** The clean-tech patent holder the micro-payouts route to. */
  payee_id: string;
  /** Statement micros per delivered kilowatt-hour (>= 0). */
  micros_per_kwh: number;
  /** Statement micros per completed charge cycle (>= 0). */
  micros_per_charge_cycle: number;
  created_at: string;
  updated_at: string;
}

/** One OTA feature's per-unlock royalty split policy of record
 * (`hardware_ota_unlock_policies`). UNIQUE per feature_code. */
export interface HardwareOtaUnlockPolicyRecord {
  id: string;
  /** The feature code of record — e.g. the self-driving sensor or
   * adaptive suspension unlock the purchase activates. */
  feature_code: string;
  /** The sensor patent licensor the royalty routes to. */
  sensor_licensor_payee_id: string;
  /** Statement micros per unlock event (> 0 — a policy pricing nothing
   * is a hostile registration). */
  micros_per_unlock: number;
  /** The licensor's share of the per-unlock royalty (basis points; the
   * residual is the platform's). */
  licensor_share_bps: number;
  created_at: string;
  updated_at: string;
}

/** One cross-licensing pair's agreement of record
 * (`hardware_cross_license_agreements`). The pair is stored canonically
 * (a < b) so the netting walk reads one direction of identity. UNIQUE
 * per (company_a_id, company_b_id). */
export interface HardwareCrossLicenseAgreementRecord {
  id: string;
  /** The agreement's reference of record (the sender's contract id). */
  agreement_ref: string;
  company_a_id: string;
  company_b_id: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Trackers — the cumulative positions.
// ---------------------------------------------------------------------------

/** The cumulative monthly connected-unit tracker
 * (`hardware_sep_unit_months`). UNIQUE per
 * (licensee_id, patent_family_id, sep_pool_code, month). */
export interface HardwareSepUnitMonthRecord {
  id: string;
  licensee_id: string;
  patent_family_id: string;
  sep_pool_code: string;
  month: string;
  cumulative_units: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Applications — the append-only money records.
// ---------------------------------------------------------------------------

/** The append-only Net Hardware Patent Realization per device activation
 * (`hardware_realization_applications`). UNIQUE per source_event_id. */
export interface HardwareRealizationApplicationRecord {
  id: string;
  source_event_id: string;
  /** The founder-specified realization keys of record. */
  patent_family_id: string;
  sep_pool_code: string;
  /** The device identity of record — the IMEI on cellular activations. */
  device_imei_mac: string;
  /** The EID of the eSIM (null where the activation carries none). */
  eid: string | null;
  period: string;
  currency: string;
  device_wholesale_asp_cents: number;
  component_cogs_base_cents: number;
  non_essential_bom_cents: number;
  /** The Net Patentable Device Value Base of record — may be negative
   * (the held verdict). */
  net_patentable_device_value_base_cents: number;
  verdict: HardwareApplicationVerdict;
  created_at: string;
}

/** The append-only tiered SEP micro-royalty per MAC log event
 * (`hardware_sep_royalty_applications`). UNIQUE per source_event_id. */
export interface HardwareSepRoyaltyApplicationRecord {
  id: string;
  source_event_id: string;
  licensee_id: string;
  patent_family_id: string;
  sep_pool_code: string;
  period: string;
  currency: string;
  policy_ref: string;
  payee_id: string;
  device_mac: string;
  connected_units: number;
  /** The per-unit royalty basis of record (the module's net selling
   * price of record, exact cents). */
  royalty_basis_cents: number;
  tier_legs: string;
  royalty_cents: number;
  /** The tracker position AFTER this application commits. */
  cumulative_units_before: number;
  cumulative_units_after: number;
  created_at: string;
}

/** The append-only automotive pool routing per production batch
 * (`hardware_pool_routing_applications`). UNIQUE per source_event_id. */
export interface HardwarePoolRoutingApplicationRecord {
  id: string;
  source_event_id: string;
  oem_id: string;
  line_id: string;
  period: string;
  currency: string;
  assignment_ref: string;
  serials_produced: number;
  cellular_pool_code: string;
  navigation_pool_code: string;
  cellular_fee_per_vehicle_cents: number;
  navigation_fee_per_vehicle_cents: number;
  cellular_routed_cents: number;
  navigation_routed_cents: number;
  total_routed_cents: number;
  created_at: string;
}

/** The append-only essentiality waterfall per routing and pool
 * (`hardware_pool_waterfall_applications`). UNIQUE per
 * (routing_source_event_id, pool_code). */
export interface HardwarePoolWaterfallApplicationRecord {
  id: string;
  routing_source_event_id: string;
  pool_code: string;
  period: string;
  currency: string;
  /** The essentiality-weighted split legs of record (JSON text). */
  split_legs: string;
  /** The pool fee pot that distributed (exact cents). */
  pool_fee_pot_cents: number;
  allocated_total_cents: number;
  created_at: string;
}

/** The append-only clean-tech micro-payout per telemetry event
 * (`hardware_telemetry_royalty_applications`). UNIQUE per
 * source_event_id. */
export interface HardwareTelemetryRoyaltyApplicationRecord {
  id: string;
  source_event_id: string;
  patent_family_id: string;
  period: string;
  currency: string;
  policy_ref: string;
  payee_id: string;
  device_serial: string;
  /** The delivered energy of record (statement micros of kWh). */
  kwh_micros: number;
  charge_cycles: number;
  micros_per_kwh: number;
  micros_per_charge_cycle: number;
  royalty_micros: number;
  royalty_cents: number;
  created_at: string;
}

/** The append-only OTA unlock split per unlock event
 * (`hardware_ota_unlock_applications`). UNIQUE per source_event_id. */
export interface HardwareOtaUnlockApplicationRecord {
  id: string;
  source_event_id: string;
  feature_code: string;
  policy_ref: string;
  sensor_licensor_payee_id: string;
  /** The activated device's identity of record. */
  device_imei_mac: string;
  period: string;
  currency: string;
  micros_per_unlock: number;
  licensor_share_bps: number;
  settlement_micros: number;
  settlement_cents: number;
  licensor_cents: number;
  platform_cents: number;
  created_at: string;
}

/** The append-only net balance clearing per agreement and period
 * (`hardware_cross_license_net_settlements`). UNIQUE per
 * (agreement_ref, period). */
export interface HardwareCrossLicenseNetSettlementRecord {
  id: string;
  agreement_ref: string;
  company_a_id: string;
  company_b_id: string;
  period: string;
  currency: string;
  /** Company A's recorded liability to Company B (exact cents). */
  owed_a_to_b_cents: number;
  /** Company B's recorded liability to Company A (exact cents). */
  owed_b_to_a_cents: number;
  /** The signed net of record (positive = dispatches to B). */
  net_cents: number;
  direction: HardwareNetDirection;
  created_at: string;
}
